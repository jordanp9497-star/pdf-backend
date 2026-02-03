import { Router } from 'express';
import { randomUUID } from 'crypto';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import PQueue from 'p-queue';
import { authenticateSupabase } from '../middlewares/auth.js';

const router = Router();

// ── In-memory ordonnances store (will be migrated to Supabase) ──
const ordonnances = [];

/**
 * Returns the local ordonnances array reference so other modules can read it.
 */
export function getOrdonnancesStore() {
  return ordonnances;
}

/**
 * Fonction centrale pour creer une ordonnance au format standard
 * Utilisee par toutes les routes (PDF et OCR)
 */
function createOrdonnance(data) {
  const ordonnance = {
    id: randomUUID(),
    source: data.source || 'pdf',
    rawText: data.rawText || '',
    doctorName: data.doctorName || null,
    patientName: data.patientName || null,
    medications: data.medications || [],
    appointments: data.appointments || [], // Compatibilite (tableau)
    rdv: data.rdv || null, // Nouveau format (objet unique)
    status: data.status || 'a_recuperer',
    createdAt: data.createdAt || new Date().toISOString(),
    type: data.type || null // Type d'ordonnance (MEDICAMENT ou RENDEZ_VOUS)
  };

  // Ajouter au store principal
  ordonnances.push(ordonnance);
  console.log('[ORD STORE] Ordonnance ajoutee au store principal');
  console.log('[ORD STORE] ID:', ordonnance.id);
  console.log('[ORD STORE] Source:', ordonnance.source);
  console.log('[ORD STORE] Type:', ordonnance.type || 'non specifie');
  console.log('[ORD STORE] RDV:', ordonnance.rdv ? `${ordonnance.rdv.appointmentTitle} - ${ordonnance.rdv.doctorName || 'N/A'}` : 'Aucun');
  console.log('[ORD STORE] Total ordonnances:', ordonnances.length);

  return ordonnance;
}

// ── Multer config (memory storage, 10 MB) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // Limite de 10MB
  }
});

// ── OCR queue (concurrency = 1, throttling) ──
const ocrQueue = new PQueue({ concurrency: 1 });
const OCR_QUEUE_MAX_SIZE = 2; // Si la queue depasse 2 jobs, renvoyer 429 OCR_BUSY

// ──────────────────────────────────────────────
// NOTE: normalizeOrdonnance, analyzeOrdonnanceText and ocrWithFallback
// are defined in index.js.  They are injected via app.locals so that
// this route file stays self-contained and does not duplicate logic.
//
// Expected app.locals:
//   - app.locals.normalizeOrdonnance
//   - app.locals.analyzeOrdonnanceText
//   - app.locals.ocrWithFallback
// ──────────────────────────────────────────────

// Route POST /api/ordonnance/finalize - Finaliser l'enregistrement d'une ordonnance selon le type
router.post('/api/ordonnance/finalize', (req, res) => {
  console.log('[FINALIZE] POST /api/ordonnance/finalize appelee');

  console.log("[FINALIZE] body keys", Object.keys(req.body || {}));
  console.log("[FINALIZE] has structured", !!req.body?.structured);
  console.log("[FINALIZE] has output", !!req.body?.output);

  // Grab helpers from app.locals
  const normalizeOrdonnance = req.app.locals.normalizeOrdonnance;

  try {
    const { structured: inputStructured, output, type } = req.body;

    // Accepter plusieurs formats d'input
    let structured = inputStructured || output || req.body;

    // Detecter si c'est le format A (doctor, patient, prescription)
    const isFormatA = structured &&
                      typeof structured === 'object' &&
                      (structured.doctor || structured.patient || structured.prescription);

    if (isFormatA) {
      console.log('[FINALIZE] Format A detecte - Conversion vers schema Medicalia');

      // Convertir du format A vers le schema Medicalia attendu
      const doctorObj = structured.doctor || {};
      const patientObj = structured.patient || {};
      const prescriptionArray = Array.isArray(structured.prescription) ? structured.prescription : [];

      // Extraire le nom du medecin (peut etre une string ou un objet avec name)
      const doctorName = typeof doctorObj === 'string'
        ? doctorObj
        : (doctorObj.name || '');

      // Extraire le nom du patient (peut etre une string ou un objet avec name)
      const patientName = typeof patientObj === 'string'
        ? patientObj
        : (patientObj.name || '');

      // Convertir les prescriptions en medicaments
      const medicaments = prescriptionArray.map(pres => ({
        nom: pres.medicament || pres.name || pres.nom || '',
        dosage: pres.dosage || '',
        posologie: pres.posologie || pres.frequency || pres.frequence || '',
        duree: pres.duration || pres.duree || null
      }));

      // Construire le schema Medicalia
      structured = {
        medecin: doctorName,
        patient: patientName,
        medicaments: medicaments,
        texte_brut: structured.rawText || structured.text || ''
      };

      console.log('[FINALIZE] Conversion terminee:', {
        medecin: structured.medecin,
        patient: structured.patient,
        medicamentsCount: structured.medicaments.length
      });
    }

    // Validation
    if (!structured || typeof structured !== 'object') {
      return res.status(400).json({
        error: 'INVALID_STRUCTURED',
        expected: 'Un objet JSON structure avec les champs suivants: { structured: { medecin, patient, medicaments, texte_brut } } OU { output: { doctor, patient, prescription, rawText } } OU directement un objet avec { doctor, patient, prescription } (format A)',
        receivedKeys: Object.keys(req.body || {})
      });
    }

    if (!type || !['MEDICAMENT', 'RENDEZ_VOUS'].includes(type)) {
      return res.status(400).json({
        error: 'INVALID_TYPE',
        receivedType: req.body?.type ?? null,
        allowedTypes: ['MEDICAMENT', 'RENDEZ_VOUS']
      });
    }

    // Extraire les donnees structurees
    const medecin = structured.medecin || '';
    const patient = structured.patient || '';
    const medicaments = structured.medicaments || [];
    const texteBrut = structured.texte_brut || '';

    // Transformer les medicaments au format attendu par createOrdonnance
    const medications = medicaments.map(med => ({
      name: med.nom || '',
      dosage: med.dosage || '',
      frequency: med.posologie || '',
      duration: med.duree || null
    }));

    // Extraire le rdv structure (nouveau format) ou appointments (ancien format)
    let rdv = null;
    let appointments = [];

    // Normaliser d'abord avec normalizeOrdonnance pour avoir le format standardise
    const normalized = normalizeOrdonnance(structured, texteBrut);

    // Utiliser rdv si present (nouveau format)
    if (normalized.rdv && typeof normalized.rdv === 'object') {
      rdv = normalized.rdv;
      appointments = [rdv]; // Compatibilite
    } else if (Array.isArray(normalized.appointments) && normalized.appointments.length > 0) {
      // Ancien format: prendre le premier appointment
      const apt = normalized.appointments[0];
      rdv = {
        appointmentTitle: apt.appointmentTitle || 'Rendez-vous medical',
        doctorName: apt.doctorName || null,
        datetimeISO: apt.datetimeISO || null,
        location: apt.location || null,
        note: apt.note || null
      };
      appointments = [rdv];
    }

    // Preparer les donnees de l'ordonnance
    const ordonnanceData = {
      source: 'ocr_manuscrit',
      rawText: texteBrut,
      doctorName: medecin || null,
      patientName: patient || null,
      medications: medications,
      appointments: appointments, // Compatibilite (tableau)
      rdv: rdv, // Nouveau format (objet unique)
      status: type === 'RENDEZ_VOUS' ? 'rdv_a_planifier' : 'a_recuperer',
      createdAt: new Date().toISOString(),
      type: type // Ajouter le type a l'ordonnance
    };

    // Creer l'ordonnance
    const ordonnance = createOrdonnance(ordonnanceData);

    // Gerer les actions specifiques selon le type
    if (type === 'MEDICAMENT') {
      console.log('[FINALIZE] Type MEDICAMENT - Preparation workflow notifications/calendrier');
      // TODO: Preparer le workflow notifications / calendrier
      // Exemple : appeler un webhook n8n pour les notifications
      // Exemple : creer des evenements calendrier pour les prises de medicaments
    } else if (type === 'RENDEZ_VOUS') {
      console.log('[FINALIZE] Type RENDEZ_VOUS - Preparation orientation Doctolib');
      // Marquer l'ordonnance comme RDV
      ordonnance.isRdv = true;

      // Log des appointments pour debug
      if (appointments.length > 0) {
        appointments.forEach((apt, idx) => {
          console.log(`[FINALIZE] Appointment ${idx + 1}:`, {
            title: apt.appointmentTitle,
            doctor: apt.doctorName,
            datetime: apt.datetimeISO || 'MANQUANT (demander a l\'utilisateur de completer)',
            location: apt.location || 'Non specifie'
          });

          // Avertir si datetimeISO est absent (requis pour calendrier)
          if (!apt.datetimeISO || apt.datetimeISO.trim() === '') {
            console.warn(`[FINALIZE] ⚠️ Appointment ${idx + 1} sans datetimeISO - ne pourra pas creer d'evenement calendrier`);
          }
        });
      }

      // TODO: Preparer l'orientation Doctolib
      // Exemple : generer un lien Doctolib ou appeler une API Doctolib
    }

    console.log('[FINALIZE] Ordonnance finalisee avec succes');
    console.log('[FINALIZE] ID:', ordonnance.id);
    console.log('[FINALIZE] Type:', type);
    console.log('[FINALIZE] Status:', ordonnance.status);

    // Retourner l'ordonnance creee
    res.status(201).json({
      success: true,
      ordonnance: ordonnance,
      type: type
    });

  } catch (error) {
    console.error('[FINALIZE] ❌ Erreur lors de la finalisation:', error.message);
    console.error('[FINALIZE] Stack:', error.stack);
    res.status(500).json({
      success: false,
      error: 'FINALIZATION_ERROR',
      message: 'Erreur lors de la finalisation de l\'ordonnance',
      details: error.message
    });
  }
});

// Route POST /api/ordonnance/analyze - Analyser un texte brut d'ordonnance
router.post('/api/ordonnance/analyze', (req, res) => {
  const traceId = randomUUID();
  console.log(`[ANALYZE][${traceId}] POST /api/ordonnance/analyze appelee`);

  // Grab helpers from app.locals
  const analyzeOrdonnanceText = req.app.locals.analyzeOrdonnanceText;

  try {
    // Verifier que le Content-Type n'est pas multipart/form-data
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      console.log(`[ANALYZE][${traceId}] ❌ Content-Type multipart/form-data recu (attendu: application/json)`);
      return res.status(400).json({
        success: false,
        error: 'INVALID_CONTENT_TYPE',
        message: 'Ce endpoint attend JSON { rawText }. Utilisez /api/ordonnance/ocr (ou endpoint upload PDF) pour envoyer un PDF.',
        traceId
      });
    }

    const { rawText } = req.body;

    // Validation
    if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
      console.log(`[ANALYZE][${traceId}] ❌ rawText invalide ou manquant`);
      return res.status(400).json({
        success: false,
        error: 'INVALID_RAWTEXT',
        message: 'Le champ rawText est requis et ne peut pas etre vide',
        traceId
      });
    }

    // Analyser le texte brut
    const analyzedData = analyzeOrdonnanceText(rawText);

    console.log(`[ANALYZE][${traceId}] ✅ Analyse terminee`);
    console.log(`[ANALYZE][${traceId}] Score de confiance:`, analyzedData.confidenceScore);
    console.log(`[ANALYZE][${traceId}] Medecin:`, analyzedData.doctor.name);
    console.log(`[ANALYZE][${traceId}] Patient:`, analyzedData.patient.name);
    console.log(`[ANALYZE][${traceId}] Prescriptions:`, analyzedData.prescription.length);

    // Retourner le JSON strict enveloppe dans { output: ... }
    return res.json({ output: analyzedData });

  } catch (error) {
    console.error(`[ANALYZE][${traceId}] ❌ Erreur lors de l'analyse:`, error?.stack || error);
    res.status(500).json({
      success: false,
      error: 'ANALYSIS_ERROR',
      message: 'Erreur lors de l\'analyse de l\'ordonnance',
      details: error.message,
      traceId
    });
  }
});

/**
 * Route POST /api/ordonnance/extract-text
 *
 * Extrait le texte brut d'un PDF
 * - Auth Bearer obligatoire (meme logique que /api/ordonnance/analyze)
 * - Attend multipart/form-data avec champ "file" (PDF)
 * - Limite: 10MB
 * - Retourne: { ok: true, rawText, meta: { length } }
 */
router.post('/api/ordonnance/extract-text',
  authenticateSupabase,
  upload.single('file'),
  async (req, res) => {
    const traceId = randomUUID();
    console.log(`[EXTRACT_TEXT][${traceId}] POST /api/ordonnance/extract-text appelee`);

    try {
      // 1. Validation: fichier requis
      if (!req.file) {
        console.log(`[EXTRACT_TEXT][${traceId}] ❌ Fichier manquant`);
        return res.status(400).json({
          ok: false,
          error: 'MISSING_FILE',
          traceId
        });
      }

      // 2. Validation: fichier non vide
      if (req.file.size === 0) {
        console.log(`[EXTRACT_TEXT][${traceId}] ❌ Fichier vide (size=0)`);
        return res.status(400).json({
          ok: false,
          error: 'EMPTY_FILE',
          traceId
        });
      }

      // Logs serveur
      console.log(`[EXTRACT_TEXT][${traceId}] mimetype: ${req.file.mimetype}, size: ${req.file.size} bytes`);

      // 3. Extraire le texte du PDF avec pdf-parse
      let pdfData;
      try {
        pdfData = await pdfParse(req.file.buffer);
      } catch (error) {
        console.error(`[EXTRACT_TEXT][${traceId}] ❌ Erreur extraction PDF:`, error?.stack || error);
        return res.status(500).json({
          ok: false,
          error: 'EXTRACT_TEXT_FAILED',
          message: error?.message || 'Erreur lors de l\'extraction du texte du PDF',
          traceId
        });
      }

      // 4. Extraire le texte brut
      const rawText = pdfData.text?.trim() || '';
      const rawTextLength = rawText.length;

      // Logs serveur
      console.log(`[EXTRACT_TEXT][${traceId}] rawTextLength: ${rawTextLength} caracteres`);

      // 5. Validation: texte extrait non vide
      if (!rawText || rawTextLength === 0) {
        console.log(`[EXTRACT_TEXT][${traceId}] ❌ Aucun texte extrait du PDF (PDF scanne probablement)`);
        return res.status(422).json({
          ok: false,
          error: 'NO_TEXT_IN_PDF',
          traceId
        });
      }

      // 6. Preparer les metadonnees
      const meta = {
        length: rawTextLength
      };

      console.log(`[EXTRACT_TEXT][${traceId}] ✅ Texte extrait avec succes: ${rawTextLength} caracteres`);

      // 7. Retourner le texte brut
      return res.status(200).json({
        ok: true,
        rawText,
        meta
      });

    } catch (error) {
      console.error(`[EXTRACT_TEXT][${traceId}] ❌ Erreur generale:`, error?.stack || error);
      return res.status(500).json({
        ok: false,
        error: 'EXTRACT_TEXT_FAILED',
        message: error?.message || 'Erreur lors de l\'extraction du texte',
        traceId
      });
    }
  }
);

/**
 * Route POST /api/ordonnance/ocr-base64
 *
 * OCR d'une image base64 (meme pipeline que la camera)
 * - Auth Bearer obligatoire
 * - Attend JSON: { imageBase64: string, profile_id?: string, device_id?: string }
 * - Decode base64 en Buffer et passe dans le pipeline OCR existant
 * - Throttling: file d'attente avec concurrence = 1
 * - Retourne: { ok: true, rawText }
 */
router.post('/api/ordonnance/ocr-base64',
  authenticateSupabase,
  async (req, res) => {
    const traceId = randomUUID();
    console.log(`[OCR_BASE64][${traceId}] POST /api/ordonnance/ocr-base64 appelee`);

    // Grab helpers from app.locals
    const ocrWithFallback = req.app.locals.ocrWithFallback;

    try {
      // 1. Validation: imageBase64 requis
      const { imageBase64, profile_id, device_id } = req.body;

      if (!imageBase64 || typeof imageBase64 !== 'string' || imageBase64.trim().length === 0) {
        console.log(`[OCR_BASE64][${traceId}] ❌ imageBase64 manquant ou invalide`);
        return res.status(400).json({
          ok: false,
          error: 'INVALID_IMAGE',
          message: 'Le champ imageBase64 (string) est requis',
          traceId
        });
      }

      // Logs serveur
      console.log(`[OCR_BASE64][${traceId}] imageBase64 length: ${imageBase64.length} caracteres`);
      if (profile_id) console.log(`[OCR_BASE64][${traceId}] profile_id: ${profile_id}`);
      if (device_id) console.log(`[OCR_BASE64][${traceId}] device_id: ${device_id}`);

      // 2. Decoder le base64 en Buffer
      let base64Data = imageBase64;
      let mimeType = 'image/jpeg';

      // Supporter data URI: "data:image/jpeg;base64,...." -> strip le prefixe si present
      if (base64Data.includes(',')) {
        const parts = base64Data.split(',');
        base64Data = parts[1];
        if (parts[0].startsWith('data:')) {
          const mimeMatch = parts[0].match(/data:([^;]+)/);
          if (mimeMatch) {
            mimeType = mimeMatch[1];
          }
        }
      }

      let imageBuffer;
      try {
        imageBuffer = Buffer.from(base64Data, 'base64');
        console.log(`[OCR_BASE64][${traceId}] Buffer cree: ${imageBuffer.length} bytes, mimeType: ${mimeType}`);
      } catch (error) {
        console.error(`[OCR_BASE64][${traceId}] ❌ Erreur decodage base64:`, error?.stack || error);
        return res.status(400).json({
          ok: false,
          error: 'INVALID_IMAGE',
          message: 'Erreur lors du decodage de l\'image base64',
          traceId
        });
      }

      // 3. Verifier que MISTRAL_API_KEY est presente
      const mistralApiKey = process.env.MISTRAL_API_KEY;
      if (!mistralApiKey) {
        console.error(`[OCR_BASE64][${traceId}] ❌ MISTRAL_API_KEY non definie`);
        return res.status(500).json({
          ok: false,
          error: 'OCR_FAILED',
          message: 'MISTRAL_API_KEY non configuree',
          traceId
        });
      }

      // 4. Verifier la taille de la file d'attente (throttling)
      const queueSize = ocrQueue.size;
      const pendingCount = ocrQueue.pending;
      console.log(`[OCR_BASE64][${traceId}] File OCR: size=${queueSize}, pending=${pendingCount}`);

      if (queueSize > OCR_QUEUE_MAX_SIZE) {
        console.log(`[OCR_BASE64][${traceId}] ❌ Queue OCR saturee (size=${queueSize} > ${OCR_QUEUE_MAX_SIZE})`);
        return res.status(429).json({
          ok: false,
          error: 'OCR_BUSY',
          message: 'OCR occupe, reessayez dans quelques instants',
          retryAfterMs: 30000,
          traceId
        });
      }

      // 5. Utiliser le pipeline OCR existant via la file d'attente (ocrWithFallback)
      let ocrResult;
      try {
        ocrResult = await ocrQueue.add(async () => {
          console.log(`[OCR_BASE64][${traceId}] Debut OCR (provider=Mistral, queue size=${ocrQueue.size}, pending=${ocrQueue.pending})`);
          return await ocrWithFallback(imageBase64, mimeType, mistralApiKey);
        });
      } catch (error) {
        // Gerer les erreurs rate limit (HTTP 429 / "Rate limit exceeded" / code 1300) => ne pas renvoyer 500
        const isRateLimit = error.status === 429 || error.statusCode === 429 ||
          (error.message && String(error.message).includes('Rate limit exceeded')) ||
          error.code === 1300 || error.errorCode === 1300;
        if (isRateLimit) {
          const retryAfter = error.retryAfter ?? error.retryAfterMs ?? 30000;
          console.error(`[OCR_BASE64][${traceId}] ❌ OCR_RATE_LIMIT provider status=${error.status ?? error.statusCode ?? 'unknown'}, retryAfterMs=${retryAfter}, queue size=${ocrQueue.size}`);
          return res.status(429).json({
            ok: false,
            error: 'OCR_RATE_LIMIT',
            message: 'OCR sature, reessayez dans quelques instants',
            retryAfterMs: retryAfter,
            traceId
          });
        }

        console.error(`[OCR_BASE64][${traceId}] ❌ Erreur OCR:`, error?.stack || error);
        console.error(`[OCR_BASE64][${traceId}] provider status: ${error.status ?? error.statusCode ?? 'unknown'}, queue size: ${ocrQueue.size}`);
        return res.status(500).json({
          ok: false,
          error: 'OCR_FAILED',
          message: error?.message || 'Erreur lors du traitement OCR',
          traceId
        });
      }

      const { text: rawText, meta } = ocrResult;

      // Logs: traceId + statut provider + queue size
      console.log(`[OCR_BASE64][${traceId}] ✅ OCR termine (provider status=ok, queue size=${ocrQueue.size}) ${rawText.length} caracteres`);

      // 6. Validation: texte OCR non vide
      if (!rawText || rawText.trim().length === 0) {
        console.log(`[OCR_BASE64][${traceId}] ❌ Texte OCR vide`);
        return res.status(400).json({
          ok: false,
          error: 'EMPTY_OCR_TEXT',
          message: 'Aucun texte extrait de l\'image',
          traceId
        });
      }

      // 7. Retourner le texte brut
      return res.status(200).json({
        ok: true,
        rawText
      });

    } catch (error) {
      console.error(`[OCR_BASE64][${traceId}] ❌ Erreur generale:`, error?.stack || error);
      return res.status(500).json({
        ok: false,
        error: 'OCR_FAILED',
        message: error?.message || 'Erreur lors du traitement OCR',
        traceId
      });
    }
  }
);

router.get('/api/ordonnances', (req, res) => {
  console.log('[ORD LIST] GET /api/ordonnances - Recuperation de toutes les ordonnances');
  console.log('[ORD LIST] Nombre d\'ordonnances retournees :', ordonnances.length);

  // Retourner toutes les ordonnances sans filtre par source
  res.status(200).json({
    success: true,
    ordonnances: ordonnances,
    count: ordonnances.length
  });
});

export default router;
