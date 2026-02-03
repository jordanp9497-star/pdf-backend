import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { N8N_CONFIG, AI_CONFIG } from '../src/config/env.js';

const router = Router();

// ===== WEBHOOK URLs (from env config) =====
const N8N_WEBHOOK_URL = N8N_CONFIG.webhookUrl;
const N8N_OCR_WEBHOOK_URL = N8N_CONFIG.ocrWebhookUrl;

// ===== IN-MEMORY ORDONNANCES STORE =====
const ordonnances = [];

/**
 * Fonction centrale pour créer une ordonnance au format standard
 * Utilisée par toutes les routes (PDF et OCR)
 * @param {Object} data - Données de l'ordonnance
 * @param {string} data.source - Source de l'ordonnance ("pdf" ou "ocr_manuscrit")
 * @param {string} data.rawText - Texte brut de l'ordonnance
 * @param {string|null} data.doctorName - Nom du médecin
 * @param {string|null} data.patientName - Nom du patient
 * @param {Array} data.medications - Liste des médicaments
 * @param {string} data.status - Statut de l'ordonnance (défaut: "a_recuperer")
 * @param {string} data.createdAt - Date de création (ISO string)
 * @returns {Object} Ordonnance créée avec id généré
 */
function createOrdonnance(data) {
  const ordonnance = {
    id: randomUUID(),
    source: data.source || 'pdf',
    rawText: data.rawText || '',
    doctorName: data.doctorName || null,
    patientName: data.patientName || null,
    medications: data.medications || [],
    appointments: data.appointments || [], // Compatibilité (tableau)
    rdv: data.rdv || null, // Nouveau format (objet unique)
    status: data.status || 'a_recuperer',
    createdAt: data.createdAt || new Date().toISOString(),
    type: data.type || null // Type d'ordonnance (MEDICAMENT ou RENDEZ_VOUS)
  };

  // Ajouter au store principal
  ordonnances.push(ordonnance);
  console.log('[ORD STORE] Ordonnance ajoutée au store principal');
  console.log('[ORD STORE] ID:', ordonnance.id);
  console.log('[ORD STORE] Source:', ordonnance.source);
  console.log('[ORD STORE] Type:', ordonnance.type || 'non spécifié');
  console.log('[ORD STORE] RDV:', ordonnance.rdv ? `${ordonnance.rdv.appointmentTitle} - ${ordonnance.rdv.doctorName || 'N/A'}` : 'Aucun');
  console.log('[ORD STORE] Total ordonnances:', ordonnances.length);

  return ordonnance;
}

// ===== MULTER CONFIGURATION =====
// Configuration multer pour POST /api/ocr/handwritten
const ocrUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // Limite de 10MB
  }
});

// ===== HELPER FUNCTIONS =====

// Fonction pour structurer le texte en sections médicales explicites
function structureText(text) {
  if (!text) return text;

  // Normaliser le texte : diviser en lignes
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '');

  // Initialiser les sections
  const prescripteur = [];
  const datePrescription = [];
  const patient = [];
  const medicaments = [];
  const informationsComplementaires = [];

  // Parcourir chaque ligne et la classer
  for (const line of lines) {
    const lowerLine = line.toLowerCase();

    // 1. PRESCRIPTEUR : Médecin, GÉNÉRALISTE, adresse, téléphone, email
    if (
      lowerLine.includes('médecin') ||
      lowerLine.includes('généraliste') ||
      lowerLine.includes('docteur') ||
      lowerLine.includes('dr.') ||
      lowerLine.includes('dr ') ||
      lowerLine.includes('@') ||
      lowerLine.includes('tel') ||
      lowerLine.includes('tél') ||
      lowerLine.includes('rue') ||
      lowerLine.includes('avenue') ||
      lowerLine.includes('boulevard') ||
      lowerLine.includes('phone') ||
      (lowerLine.match(/\d{2}\s\d{2}\s\d{2}\s\d{2}\s\d{2}/) && !lowerLine.includes('né')) ||
      (lowerLine.match(/\d{10}/) && !lowerLine.includes('né'))
    ) {
      prescripteur.push(line);
      continue;
    }

    // 2. DATE_PRESCRIPTION : Dates isolées "Le 23 mars 2025" ou formats similaires
    const monthNames = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const hasMonth = monthNames.some(month => lowerLine.includes(month));

    if (
      (lowerLine.includes('le ') && lowerLine.includes('202')) ||
      lowerLine.match(/^le\s+\d{1,2}\s+\w+\s+\d{4}$/i) ||
      lowerLine.match(/^\d{1,2}\/\d{1,2}\/\d{4}$/) ||
      lowerLine.match(/^\d{1,2}\s+\w+\s+\d{4}$/i) ||
      (lowerLine.startsWith('le ') && hasMonth)
    ) {
      datePrescription.push(line);
      continue;
    }

    // 3. PATIENT : M., Mme, né(e), Né(e)
    if (
      lowerLine.includes('m. ') ||
      lowerLine.includes('mme ') ||
      lowerLine.includes('melle ') ||
      lowerLine.includes('né ') ||
      lowerLine.includes('née ') ||
      lowerLine.includes('né(e)') ||
      lowerLine.includes('née(e)') ||
      lowerLine.startsWith('m.') ||
      lowerLine.startsWith('mme') ||
      lowerLine.startsWith('melle')
    ) {
      patient.push(line);
      continue;
    }

    // 4. MEDICAMENTS : Noms en majuscules, posologie (fois, jours, mg, g, sachet, comprimé)
    const hasPosologie = (
      lowerLine.includes('fois') ||
      lowerLine.includes('jour') ||
      lowerLine.includes('mg') ||
      lowerLine.includes(' g ') ||
      lowerLine.match(/\d+g\b/) ||
      lowerLine.match(/\d+mg/) ||
      lowerLine.includes('sachet') ||
      lowerLine.includes('comprimé') ||
      lowerLine.includes('comp') ||
      lowerLine.includes('cp') ||
      lowerLine.includes('ml') ||
      lowerLine.includes('matin') ||
      lowerLine.includes('soir') ||
      lowerLine.includes('midi')
    );

    const hasMedicamentName = (
      line.match(/^[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ][A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ\s]+/) ||
      line.match(/[A-Z]{3,}/) ||
      lowerLine.includes('doliprane') ||
      lowerLine.includes('paracétamol') ||
      lowerLine.includes('amoxicilline') ||
      lowerLine.includes('ibuprofène') ||
      lowerLine.includes('aspirine')
    );

    if (hasPosologie || hasMedicamentName) {
      medicaments.push(line);
      continue;
    }

    // 5. INFORMATIONS_COMPLEMENTAIRES : Tout le reste
    informationsComplementaires.push(line);
  }

  // Construire le texte structuré avec les sections
  let structuredText = '';

  if (prescripteur.length > 0) {
    structuredText += 'PRESCRIPTEUR:\n';
    structuredText += prescripteur.join('\n') + '\n\n';
  }

  if (datePrescription.length > 0) {
    structuredText += 'DATE_PRESCRIPTION:\n';
    structuredText += datePrescription.join('\n') + '\n\n';
  }

  if (patient.length > 0) {
    structuredText += 'PATIENT:\n';
    structuredText += patient.join('\n') + '\n\n';
  }

  if (medicaments.length > 0) {
    structuredText += 'MEDICAMENTS:\n';
    structuredText += medicaments.join('\n') + '\n\n';
  }

  if (informationsComplementaires.length > 0) {
    structuredText += 'INFORMATIONS_COMPLEMENTAIRES:\n';
    structuredText += informationsComplementaires.join('\n') + '\n';
  }

  return structuredText.trim();
}

/**
 * Analyse un texte brut d'ordonnance (OCR ou PDF) et retourne un JSON structuré strict
 * @param {string} rawText - Texte brut extrait de l'OCR ou du PDF
 * @returns {Object} JSON structuré selon le schéma Medicalia strict
 */
function analyzeOrdonnanceText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return {
      doctor: { name: "", speciality: "", rpps: "" },
      patient: { name: "", birthDate: "" },
      prescription: [],
      additionalInstructions: "",
      appointments: [],
      issueDate: "",
      confidenceScore: 0.0,
      source: "OCR"
    };
  }

  const text = rawText.trim();
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  const textLower = text.toLowerCase();

  let confidenceScore = 0.0;
  let foundElements = 0;
  const totalElements = 6; // doctor, patient, prescription, instructions, appointments, issueDate

  // ===== EXTRACTION DU MÉDECIN =====
  let doctorName = "";
  let doctorSpeciality = "";
  let doctorRpps = "";

  // Chercher le nom du médecin
  const doctorMarkers = ['dr ', 'docteur', 'médecin', 'prescripteur', 'dr.', 'doct.'];
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();

    for (const marker of doctorMarkers) {
      if (lineLower.includes(marker)) {
        let extracted = lines[i];
        const markerIndex = extracted.toLowerCase().indexOf(marker);
        if (markerIndex !== -1) {
          extracted = extracted.substring(markerIndex + marker.length).trim();
        }
        extracted = extracted.replace(/^[:\-.,;]\s*/, '').trim();

        const words = extracted.split(/\s+/).filter(w => w.length > 0);
        if (words.length >= 1) {
          doctorName = words.slice(0, 3).join(' ').trim();
          foundElements++;
          break;
        }
      }
    }
    if (doctorName) break;
  }

  // Chercher la spécialité
  const specialityMarkers = ['spécialité', 'specialite', 'spécialiste en', 'médecin généraliste', 'généraliste'];
  for (const line of lines) {
    const lineLower = line.toLowerCase();
    for (const marker of specialityMarkers) {
      if (lineLower.includes(marker)) {
        const index = lineLower.indexOf(marker);
        doctorSpeciality = line.substring(index + marker.length).trim().replace(/^[:\-.,;]\s*/, '');
        if (doctorSpeciality) foundElements++;
        break;
      }
    }
    if (doctorSpeciality) break;
  }

  // Chercher le RPPS (numéro à 11 chiffres)
  const rppsMatch = text.match(/\b(\d{11})\b/);
  if (rppsMatch) {
    doctorRpps = rppsMatch[1];
  }

  // ===== EXTRACTION DU PATIENT =====
  let patientName = "";
  let patientBirthDate = "";

  const patientMarkers = [
    'identification du patient',
    'patient:',
    'patient :',
    'nom:',
    'nom :',
    'nom du patient',
    'm.',
    'mme',
    'melle',
    'monsieur',
    'madame'
  ];

  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();

    for (const marker of patientMarkers) {
      if (lineLower.includes(marker)) {
        let extracted = lines[i];
        const markerIndex = extracted.toLowerCase().indexOf(marker);
        if (markerIndex !== -1) {
          extracted = extracted.substring(markerIndex + marker.length).trim();
        }

        if (!extracted && i + 1 < lines.length) {
          extracted = lines[i + 1];
        }

        extracted = extracted
          .replace(/^(m\.|mme|melle|monsieur|madame|mademoiselle)\s*/i, '')
          .replace(/^nom\s*:?\s*/i, '')
          .trim();

        if (extracted && extracted.length > 1) {
          patientName = extracted;
          foundElements++;
          break;
        }
      }
    }
    if (patientName) break;
  }

  // Chercher la date de naissance (format DD/MM/YYYY, DD-MM-YYYY, ou DD.MM.YYYY)
  const birthDatePatterns = [
    /(?:né|née|naissance|né le|née le)\s*:?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})/i,
    /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})/
  ];

  for (const pattern of birthDatePatterns) {
    const match = text.match(pattern);
    if (match) {
      patientBirthDate = match[1];
      foundElements++;
      break;
    }
  }

  // ===== EXTRACTION DES PRESCRIPTIONS =====
  const prescription = [];

  const medicationIndicators = [
    /\d+\s*(mg|ml|g|µg|mcg)\b/i,
    /comprimé/i,
    /gélule/i,
    /cp\b/i,
    /fois\s+par\s+jour/i,
    /\d+\s*(fois|fois\/jour)/i,
    /matin|midi|soir/i,
    /jour|jours|semaine|semaines|mois/i
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase();

    const hasMedicationIndicator = medicationIndicators.some(pattern =>
      typeof pattern === 'string' ? lineLower.includes(pattern) : pattern.test(line)
    );

    if (hasMedicationIndicator) {
      const words = line.split(/\s+/);
      let medicament = "";
      let dosage = "";
      let posologie = "";
      let duration = "";

      // Nom du médicament (premier mot capitalisé ou plusieurs mots en majuscules)
      for (let j = 0; j < words.length; j++) {
        const word = words[j];
        if (word.match(/^[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþ]+/) ||
            word.match(/^[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ]{2,}$/)) {
          let nameWords = [word];
          for (let k = j + 1; k < words.length && k < j + 4; k++) {
            if (words[k].match(/^\d/) || words[k].match(/(mg|ml|g|comprimé|gélule)/i)) {
              break;
            }
            nameWords.push(words[k]);
          }
          medicament = nameWords.join(' ').trim();
          break;
        }
      }

      // Dosage (mg, ml, g, comprimé, gélule)
      const dosageMatch = line.match(/(\d+\s*(?:mg|ml|g|µg|mcg|comprimé|gélule|cp)\b)/i);
      if (dosageMatch) {
        dosage = dosageMatch[1].trim();
      }

      // Posologie (fréquence)
      const posologiePatterns = [
        /(\d+\s*fois\s*par\s*jour)/i,
        /(\d+\s*fois\/jour)/i,
        /(matin|midi|soir)/i,
        /(\d+\s*fois)/i,
        /(avant|après)\s*(?:les\s*)?(?:repas|repas)/i
      ];

      for (const pattern of posologiePatterns) {
        const match = line.match(pattern);
        if (match) {
          posologie = match[1] || match[0];
          break;
        }
      }

      // Duration (jours, semaines, mois)
      const durationMatch = line.match(/(\d+)\s*(jour|jours|semaine|semaines|mois)/i);
      if (durationMatch) {
        duration = `${durationMatch[1]} ${durationMatch[2]}`;
      }

      // Ajouter la prescription si on a au moins un médicament ou un dosage
      if (medicament || dosage) {
        prescription.push({
          medicament: medicament || "",
          dosage: dosage || "",
          posologie: posologie || "",
          duration: duration || ""
        });
      }
    }
  }

  if (prescription.length > 0) {
    foundElements++;
  }

  // ===== EXTRACTION DES INSTRUCTIONS ADDITIONNELLES =====
  let additionalInstructions = "";

  const instructionMarkers = [
    'instructions',
    'observations',
    'remarques',
    'note',
    'précautions',
    'conseils'
  ];

  let instructionStartIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    for (const marker of instructionMarkers) {
      if (lineLower.includes(marker)) {
        instructionStartIndex = i;
        break;
      }
    }
    if (instructionStartIndex !== -1) break;
  }

  if (instructionStartIndex !== -1) {
    additionalInstructions = lines.slice(instructionStartIndex).join(' ').trim();
    foundElements++;
  }

  // ===== EXTRACTION DES RENDEZ-VOUS =====
  const appointments = [];

  const appointmentPatterns = [
    /(?:rdv|rendez-vous|consultation)\s*:?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})/i,
    /(?:rdv|rendez-vous|consultation)\s*:?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})\s*(?:à|@)?\s*(\d{1,2}[:h]\d{2})/i
  ];

  for (const pattern of appointmentPatterns) {
    const matches = text.matchAll(new RegExp(pattern.source, 'gi'));
    for (const match of matches) {
      appointments.push(match[0].trim());
    }
  }

  if (appointments.length > 0) {
    foundElements++;
  }

  // ===== EXTRACTION DE LA DATE D'ÉMISSION =====
  let issueDate = "";

  const datePatterns = [
    /(?:date|le)\s*:?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})/i,
    /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})/
  ];

  // Chercher la date la plus récente (probablement la date d'émission)
  const allDates = [];
  for (const pattern of datePatterns) {
    const matches = text.matchAll(new RegExp(pattern.source, 'gi'));
    for (const match of matches) {
      allDates.push(match[1] || match[0]);
    }
  }

  if (allDates.length > 0) {
    // Prendre la dernière date trouvée (généralement la date d'émission)
    issueDate = allDates[allDates.length - 1];
    foundElements++;
  }

  // ===== CALCUL DU SCORE DE CONFIANCE =====
  confidenceScore = foundElements / totalElements;

  // Bonus si on a plusieurs prescriptions
  if (prescription.length > 1) {
    confidenceScore = Math.min(1.0, confidenceScore + 0.1);
  }

  // Bonus si on a des informations complètes
  if (doctorName && patientName && prescription.length > 0) {
    confidenceScore = Math.min(1.0, confidenceScore + 0.1);
  }

  // ===== RETOUR DU JSON STRICT =====
  return {
    doctor: {
      name: doctorName,
      speciality: doctorSpeciality,
      rpps: doctorRpps
    },
    patient: {
      name: patientName,
      birthDate: patientBirthDate
    },
    prescription: prescription,
    additionalInstructions: additionalInstructions,
    appointments: appointments,
    issueDate: issueDate,
    confidenceScore: Math.round(confidenceScore * 100) / 100, // Arrondir à 2 décimales
    source: "OCR"
  };
}

/**
 * Normalise une ordonnance structurée au format canonique strict
 * Garantit que tous les champs sont présents, même s'ils sont vides
 * @param {Object} structured - Données structurées (peuvent être partielles)
 * @param {string} rawText - Texte OCR brut
 * @returns {Object} Ordonnance normalisée au format canonique strict
 */
function normalizeOrdonnance(structured, rawText = '') {
  // Normaliser le docteur
  const doctor = {
    name: structured?.doctor?.name ||
           structured?.doctorName ||
           '',
    speciality: structured?.doctor?.speciality ||
                structured?.speciality ||
                '',
    rpps: structured?.doctor?.rpps ||
          structured?.rpps ||
          ''
  };

  // Normaliser le patient
  const patient = {
    name: structured?.patient?.name ||
           structured?.patientName ||
           '',
    birthDate: structured?.patient?.birthDate ||
               structured?.birthDate ||
               ''
  };

  // Normaliser les prescriptions
  let prescription = [];

  if (Array.isArray(structured?.prescription)) {
    prescription = structured.prescription.map(p => ({
      medicament: p.medicament || p.name || p.nom || '',
      dosage: p.dosage || '',
      posologie: p.posologie || p.frequency || p.frequence || '',
      duration: p.duration || p.duree || ''
    }));
  } else if (Array.isArray(structured?.medications) || Array.isArray(structured?.medicaments)) {
    const meds = structured.medications || structured.medicaments;
    prescription = meds.map(p => ({
      medicament: p.medicament || p.name || p.nom || '',
      dosage: p.dosage || '',
      posologie: p.posologie || p.frequency || p.frequence || '',
      duration: p.duration || p.duree || ''
    }));
  }

  // Normaliser les autres champs
  const additionalInstructions = structured?.additionalInstructions ||
                                 structured?.instructions ||
                                 structured?.observations ||
                                 '';

  // Fonction pour nettoyer appointmentTitle (retirer mots inutiles, max 50 chars)
  const cleanAppointmentTitle = (title) => {
    if (!title || typeof title !== 'string') return null;

    let cleaned = title.trim();

    // Retirer les mots inutiles (insensible à la casse)
    const uselessWords = [
      'rendez-vous', 'rdv', 'rdv:', 'rendez vous',
      'chez', 'à', 'le', 'la', 'les', 'pour', 'avec',
      'docteur', 'dr', 'pr', 'professeur', 'médecin'
    ];

    uselessWords.forEach(word => {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      cleaned = cleaned.replace(regex, '').trim();
    });

    // Nettoyer les espaces multiples
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    // Limiter à 50 caractères
    if (cleaned.length > 50) {
      cleaned = cleaned.substring(0, 47) + '...';
    }

    // Capitaliser première lettre
    if (cleaned.length > 0) {
      cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
    }

    return cleaned || null;
  };

  // Fonction pour normaliser doctorName (Dr <Nom> ou null)
  const normalizeDoctorName = (doctorName, prescriberName = '') => {
    if (!doctorName || typeof doctorName !== 'string') return null;

    let cleaned = doctorName.trim();

    // Retirer les titres et garder juste le nom avec "Dr"
    cleaned = cleaned.replace(/^(docteur|dr\.?|pr\.?|professeur)\s+/i, '');
    cleaned = cleaned.replace(/^(docteur|dr\.?|pr\.?|professeur)\s+/i, ''); // Au cas où il y en a deux

    // Nettoyer les espaces
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    // Si on a un nom, préfixer avec "Dr"
    if (cleaned.length > 0) {
      // Capitaliser première lettre de chaque mot
      cleaned = cleaned.split(' ').map(word =>
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      ).join(' ');

      return `Dr ${cleaned}`;
    }

    return null;
  };

  // Fonction pour parser datetimeISO (date + heure, défaut 09:00 si date seule)
  const parseDateTimeISO = (dateStr, timeStr = null) => {
    if (!dateStr || typeof dateStr !== 'string') return null;

    // Parser la date (formats: DD/MM/YYYY, DD-MM-YYYY, etc.)
    const dateMatch = dateStr.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
    if (!dateMatch) {
      // Essayer format ISO déjà présent
      if (dateStr.includes('T') || dateStr.includes('Z')) {
        return dateStr;
      }
      return null;
    }

    const [, day, month, year] = dateMatch;

    // Parser l'heure si présente
    let hours = '09'; // Défaut 09:00
    let minutes = '00';

    if (timeStr) {
      const timeMatch = timeStr.match(/(\d{1,2})[:h](\d{2})/);
      if (timeMatch) {
        hours = timeMatch[1].padStart(2, '0');
        minutes = timeMatch[2];
      }
    } else if (dateStr.match(/(\d{1,2})[:h](\d{2})/)) {
      // Heure dans la même string que la date
      const timeMatch = dateStr.match(/(\d{1,2})[:h](\d{2})/);
      if (timeMatch) {
        hours = timeMatch[1].padStart(2, '0');
        minutes = timeMatch[2];
      }
    }

    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hours}:${minutes}:00+01:00`;
  };

  // Normaliser le rendez-vous (nouveau format: rdv comme objet unique)
  let rdv = null;

  // Support nouveau format: rdv (objet unique)
  if (structured?.rdv && typeof structured.rdv === 'object') {
    const rdvData = structured.rdv;

    // Nettoyer appointmentTitle
    const rawTitle = rdvData.appointmentTitle || rdvData.title || rdvData.motif || '';
    const appointmentTitle = cleanAppointmentTitle(rawTitle) || 'Rendez-vous médical';

    // Normaliser doctorName (NE PAS utiliser le prescripteur)
    const doctorName = normalizeDoctorName(rdvData.doctorName || rdvData.doctor || rdvData.medecin || '');

    // Parser datetimeISO
    const datetimeISO = parseDateTimeISO(
      rdvData.datetimeISO || rdvData.datetime || rdvData.date || '',
      rdvData.time || rdvData.heure || null
    );

    // Location (null si absent)
    const location = (rdvData.location || rdvData.lieu || rdvData.adresse || rdvData.address || '').trim() || null;

    // Note (null si absent)
    const note = (rdvData.note || rdvData.notes || '').trim() || null;

    rdv = {
      appointmentTitle,
      doctorName,
      datetimeISO,
      location,
      note
    };
  }
  // Support ancien format: appointments (tableau) - compatibilité
  else if (Array.isArray(structured?.appointments) && structured.appointments.length > 0) {
    const apt = structured.appointments[0]; // Prendre le premier

    if (typeof apt === 'object' && apt !== null) {
      const rawTitle = apt.appointmentTitle || apt.title || apt.motif || '';
      const appointmentTitle = cleanAppointmentTitle(rawTitle) || 'Rendez-vous médical';

      const doctorName = normalizeDoctorName(apt.doctorName || apt.doctor || apt.medecin || '');

      const datetimeISO = parseDateTimeISO(
        apt.datetimeISO || apt.datetime || apt.date || '',
        apt.time || apt.heure || null
      );

      const location = (apt.location || apt.lieu || apt.adresse || apt.address || '').trim() || null;
      const note = (apt.note || apt.notes || '').trim() || null;

      rdv = {
        appointmentTitle,
        doctorName,
        datetimeISO,
        location,
        note
      };
    }
  }

  // Convertir rdv en appointments pour compatibilité (si rdv existe)
  const appointments = rdv ? [rdv] : [];

  // ===== TESTS/EXEMPLES D'EXTRACTION RDV (pour vérification) =====
  // Ces tests peuvent être activés pour vérifier le comportement de l'extraction
  if (process.env.TEST_RDV_EXTRACTION === 'true') {
    console.log('[TEST_RDV] Tests d\'extraction RDV activés');

    // Test 1: "RDV échographie T2 Dr Martin le 12/02 à 14h"
    const test1Title = 'RDV échographie T2 Dr Martin le 12/02 à 14h';
    const test1Doctor = 'Dr Martin';
    const test1Date = '12/02/2024';
    const test1Time = '14h';
    const cleaned1 = cleanAppointmentTitle(test1Title);
    const doctor1 = normalizeDoctorName(test1Doctor);
    const datetime1 = parseDateTimeISO(test1Date, test1Time);
    console.log('[TEST_RDV] Test 1:', {
      input: test1Title,
      expected: { title: 'Échographie T2', doctor: 'Dr Martin', datetime: '2024-02-12T14:00:00+01:00' },
      actual: { title: cleaned1, doctor: doctor1, datetime: datetime1 }
    });

    // Test 2: "Consultation cardiologie 03/03"
    const test2Title = 'Consultation cardiologie 03/03';
    const test2Date = '03/03/2024';
    const cleaned2 = cleanAppointmentTitle(test2Title);
    const doctor2 = normalizeDoctorName(null);
    const datetime2 = parseDateTimeISO(test2Date);
    console.log('[TEST_RDV] Test 2:', {
      input: test2Title,
      expected: { title: 'Consultation cardiologie', doctor: null, datetime: '2024-03-03T09:00:00+01:00' },
      actual: { title: cleaned2, doctor: doctor2, datetime: datetime2 }
    });

    // Test 3: "RDV hôpital Pitié-Salpêtrière"
    const test3Title = 'RDV hôpital Pitié-Salpêtrière';
    const test3Location = 'Hôpital Pitié-Salpêtrière';
    const cleaned3 = cleanAppointmentTitle(test3Title);
    const doctor3 = normalizeDoctorName(null);
    const datetime3 = parseDateTimeISO(null);
    console.log('[TEST_RDV] Test 3:', {
      input: test3Title,
      expected: { title: 'Hôpital Pitié-Salpêtrière', doctor: null, datetime: null, location: test3Location },
      actual: { title: cleaned3, doctor: doctor3, datetime: datetime3, location: test3Location }
    });
  }

  const issueDate = structured?.issueDate ||
                    structured?.date ||
                    structured?.datePrescription ||
                    '';

  // Normaliser le score de confiance (doit être un nombre entre 0 et 1)
  let confidenceScore = 0;
  if (typeof structured?.confidenceScore === 'number') {
    confidenceScore = Math.max(0, Math.min(1, structured.confidenceScore));
  } else if (typeof structured?.confidenceScore === 'string') {
    const parsed = parseFloat(structured.confidenceScore);
    confidenceScore = isNaN(parsed) ? 0 : Math.max(0, Math.min(1, parsed));
  }

  // Retourner l'ordonnance normalisée au format canonique strict
  return {
    doctor,
    patient,
    prescription,
    additionalInstructions,
    appointments,
    issueDate,
    confidenceScore: Math.round(confidenceScore * 100) / 100, // Arrondir à 2 décimales
    source: 'OCR',
    rawText: typeof rawText === 'string' ? rawText : ''
  };
}

/**
 * Mappe le texte OCR brut vers les champs métier de l'ordonnance (déterministe)
 * @param {string} ocrText - Texte brut extrait de l'OCR
 * @returns {Object} Champs structurés : { patientName, doctorName, medications }
 */
function mapOcrToOrdonnanceFields(ocrText) {
  if (!ocrText || typeof ocrText !== 'string') {
    return {
      patientName: 'Non renseigné',
      doctorName: 'Non renseigné',
      medications: []
    };
  }

  const text = ocrText.trim();
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  const textLower = text.toLowerCase();

  // ===== EXTRACTION DU PATIENT =====
  let patientName = null;

  // Chercher après "Identification du patient", "Patient", "Nom"
  const patientMarkers = [
    'identification du patient',
    'patient:',
    'patient :',
    'nom:',
    'nom :',
    'nom du patient',
    'm.',
    'mme',
    'melle'
  ];

  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();

    for (const marker of patientMarkers) {
      if (lineLower.includes(marker)) {
        // Prendre la ligne suivante ou extraire de la ligne actuelle
        let extracted = lines[i];

        // Si la ligne contient le marqueur, extraire ce qui suit
        const markerIndex = extracted.toLowerCase().indexOf(marker);
        if (markerIndex !== -1) {
          extracted = extracted.substring(markerIndex + marker.length).trim();
        }

        // Si vide, prendre la ligne suivante
        if (!extracted && i + 1 < lines.length) {
          extracted = lines[i + 1];
        }

        // Nettoyer : supprimer titres inutiles, garder le nom
        extracted = extracted
          .replace(/^(m\.|mme|melle|monsieur|madame|mademoiselle)\s*/i, '')
          .replace(/^nom\s*:?\s*/i, '')
          .trim();

        if (extracted && extracted.length > 1) {
          patientName = extracted;
          break;
        }
      }
    }

    if (patientName) break;
  }

  // Si pas trouvé, chercher des patterns de nom (M. Nom, Mme Nom)
  if (!patientName) {
    for (const line of lines) {
      const nameMatch = line.match(/^(m\.|mme|melle|monsieur|madame)\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþ\s-]+)/i);
      if (nameMatch && nameMatch[2]) {
        patientName = nameMatch[2].trim();
        break;
      }
    }
  }

  patientName = patientName || 'Non renseigné';

  // ===== EXTRACTION DU MÉDECIN =====
  let doctorName = null;

  // Chercher après "Dr", "Docteur", "Médecin"
  const doctorMarkers = ['dr ', 'docteur', 'médecin', 'prescripteur'];

  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();

    for (const marker of doctorMarkers) {
      if (lineLower.includes(marker)) {
        let extracted = lines[i];

        // Extraire ce qui suit le marqueur
        const markerIndex = extracted.toLowerCase().indexOf(marker);
        if (markerIndex !== -1) {
          extracted = extracted.substring(markerIndex + marker.length).trim();
        }

        // Nettoyer : supprimer ponctuation et caractères inutiles
        extracted = extracted
          .replace(/^[:\-.,;]\s*/, '')
          .replace(/\s*[:\-.,;]\s*$/, '')
          .trim();

        // Prendre les 2-3 premiers mots (nom du médecin)
        const words = extracted.split(/\s+/).filter(w => w.length > 0);
        if (words.length >= 1) {
          doctorName = words.slice(0, 3).join(' ').trim();
          break;
        }
      }
    }

    if (doctorName) break;
  }

  doctorName = doctorName || 'Non renseigné';

  // ===== EXTRACTION DES MÉDICAMENTS =====
  const medications = [];

  // Détecter les lignes contenant des médicaments
  const medicationIndicators = [
    /\d+\s*(mg|ml|g|µg|mcg)\b/i,
    /comprimé/i,
    /gélule/i,
    /cp\b/i,
    /fois\s+par\s+jour/i,
    /\d+\s*(fois|fois\/jour)/i,
    /matin|midi|soir/i,
    /jour|jours|semaine|semaines|mois/i
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase();

    // Vérifier si la ligne contient des indicateurs de médicament
    const hasMedicationIndicator = medicationIndicators.some(pattern =>
      typeof pattern === 'string' ? lineLower.includes(pattern) : pattern.test(line)
    );

    if (hasMedicationIndicator) {
      // Extraire le nom du médicament (premier mot capitalisé ou plusieurs mots en majuscules)
      const words = line.split(/\s+/);
      let name = '';
      let dosage = '';
      let frequency = '';
      let duration = null;

      // Nom : chercher un mot capitalisé ou en majuscules au début
      for (let j = 0; j < words.length; j++) {
        const word = words[j];
        if (word.match(/^[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþ]+/) ||
            word.match(/^[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ]{2,}$/)) {
          // Prendre ce mot et les suivants jusqu'à un nombre ou indicateur de dosage
          let nameWords = [word];
          for (let k = j + 1; k < words.length && k < j + 4; k++) {
            if (words[k].match(/^\d/) || words[k].match(/(mg|ml|g|comprimé|gélule)/i)) {
              break;
            }
            nameWords.push(words[k]);
          }
          name = nameWords.join(' ').trim();
          break;
        }
      }

      // Dosage : chercher mg, ml, g, comprimé, gélule
      const dosageMatch = line.match(/(\d+\s*(mg|ml|g|µg|mcg|comprimé|gélule|cp)\b)/i);
      if (dosageMatch) {
        dosage = dosageMatch[1].trim();
      }

      // Frequency : chercher "fois par jour", "matin", "soir", etc.
      const frequencyPatterns = [
        /(\d+\s*fois\s*par\s*jour)/i,
        /(\d+\s*fois\/jour)/i,
        /(matin|midi|soir)/i,
        /(\d+\s*fois)/i
      ];

      for (const pattern of frequencyPatterns) {
        const match = line.match(pattern);
        if (match) {
          frequency = match[1].trim();
          break;
        }
      }

      // Duration : chercher "jours", "semaines", "mois"
      const durationMatch = line.match(/(\d+)\s*(jour|jours|semaine|semaines|mois)/i);
      if (durationMatch) {
        duration = `${durationMatch[1]} ${durationMatch[2]}`;
      }

      // Si on a au moins un nom ou un dosage, créer le médicament
      if (name || dosage) {
        medications.push({
          name: name || 'Médicament non identifié',
          dosage: dosage || '',
          frequency: frequency || '',
          duration: duration
        });
      }
    }
  }

  const result = {
    patientName,
    doctorName,
    medications: medications.length > 0 ? medications : []
  };

  console.log('[OCR MAP] Champs mappés :', {
    patientName: result.patientName,
    doctorName: result.doctorName,
    medications: result.medications
  });

  return result;
}

/**
 * Structure une ordonnance OCR brute via l'IA (n8n) - DÉPRÉCIÉ, utiliser mapOcrToOrdonnanceFields
 * @param {string} rawText - Texte brut extrait de l'OCR
 * @returns {Promise<Object>} Ordonnance structurée au format Medicalia
 */
async function structureOcrOrdonnance(rawText) {
  console.log('[OCR STRUCT] Début de la restructuration OCR via IA');

  try {
    // 1. Appeler le webhook n8n avec le texte OCR brut
    const n8nData = {
      text: rawText.trim()
    };

    console.log('[OCR STRUCT] Appel n8n avec texte OCR brut...');
    const n8nResponse = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(n8nData)
    });

    if (!n8nResponse.ok) {
      const errorText = await n8nResponse.text();
      console.error('[OCR STRUCT] ❌ Erreur HTTP n8n:', n8nResponse.status, errorText);
      throw new Error(`n8n returned status ${n8nResponse.status}`);
    }

    // 2. Lire la réponse brute
    const rawResponse = await n8nResponse.text();

    if (!rawResponse || rawResponse.trim() === "") {
      throw new Error('Réponse n8n vide');
    }

    // 3. Parser la réponse JSON
    let parsed;
    try {
      parsed = JSON.parse(rawResponse);
    } catch (e) {
      console.error('[OCR STRUCT] ❌ Erreur parsing réponse n8n:', e);
      throw new Error('Réponse n8n invalide (JSON)');
    }

    // 4. Extraire le champ result (qui contient un JSON stringifié)
    let structuredData;
    if (parsed.result) {
      try {
        structuredData = JSON.parse(parsed.result);
      } catch (e) {
        // Si result n'est pas une string JSON, utiliser parsed directement
        structuredData = parsed;
      }
    } else {
      structuredData = parsed;
    }

    // 5. Transformer la réponse n8n au format Medicalia standard
    const ordonnanceStructured = {
      doctorName: structuredData.meta?.prescripteur?.nom ||
                  structuredData.prescripteur?.nom ||
                  structuredData.doctorName ||
                  null,
      patientName: structuredData.patient?.nom ||
                   structuredData.patientName ||
                   null,
      medications: []
    };

    // 6. Transformer les médicaments
    if (structuredData.medicaments && Array.isArray(structuredData.medicaments)) {
      ordonnanceStructured.medications = structuredData.medicaments.map(med => ({
        name: med.nom || med.name || '',
        dosage: med.posologie || med.dosage || '',
        frequency: med.frequence || med.frequency || '',
        duration: med.duree || med.duration || null
      }));
    } else if (structuredData.medications && Array.isArray(structuredData.medications)) {
      ordonnanceStructured.medications = structuredData.medications.map(med => ({
        name: med.name || '',
        dosage: med.dosage || '',
        frequency: med.frequency || '',
        duration: med.duration || null
      }));
    }

    console.log('[OCR STRUCT] Ordonnance OCR restructurée');
    console.log('[OCR STRUCT] Médecin:', ordonnanceStructured.doctorName);
    console.log('[OCR STRUCT] Patient:', ordonnanceStructured.patientName);
    console.log('[OCR STRUCT] Médicaments:', ordonnanceStructured.medications.length);

    return ordonnanceStructured;

  } catch (error) {
    console.error('[OCR STRUCT] ❌ Erreur lors de la restructuration:', error.message);
    throw error;
  }
}

/**
 * Pré-traite une image base64 via le microservice OpenCV si activé.
 * Si l'appel échoue, retourne l'image originale.
 * Ne modifie jamais le format attendu par l'OCR.
 *
 * @param {string} base64Image - Image en base64 (avec ou sans prefix data:image)
 * @returns {Promise<string>} - Image base64 pré-traitée ou originale en cas d'erreur
 */
async function preprocessImageIfEnabled(base64Image) {
  const opencvUrl = process.env.OPENCV_PREPROCESS_URL;

  // Si l'URL n'est pas configurée, retourner l'image originale
  if (!opencvUrl || opencvUrl.trim() === '') {
    console.log('[PREPROCESS] OPENCV_PREPROCESS_URL non configurée, skip pré-traitement');
    return base64Image;
  }

  try {
    console.log('[PREPROCESS] Appel microservice OpenCV:', opencvUrl);

    // Créer un AbortController pour gérer le timeout
    const abortController = new AbortController();
    const timeoutMs = 30000; // 30 secondes
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    const response = await fetch(`${opencvUrl}/preprocess`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        base64: base64Image
      }),
      signal: abortController.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.warn('[PREPROCESS] Erreur microservice OpenCV:', response.status, errorText);
      return base64Image; // Retourner l'originale en cas d'erreur
    }

    const result = await response.json();

    if (result.success && result.base64) {
      console.log('[PREPROCESS] Image pré-traitée avec succès');
      return result.base64;
    } else {
      console.warn('[PREPROCESS] Réponse OpenCV invalide:', result.error || 'unknown');
      return base64Image; // Retourner l'originale
    }

  } catch (error) {
    // Gérer tous les types d'erreurs (timeout, réseau, etc.)
    if (error.name === 'AbortError') {
      console.warn('[PREPROCESS] Timeout lors de l\'appel OpenCV');
    } else {
      console.warn('[PREPROCESS] Erreur lors de l\'appel OpenCV:', error.message);
    }
    return base64Image; // Toujours retourner l'originale en cas d'erreur
  }
}

/**
 * Effectue l'OCR avec fallback : tente avec l'image pré-traitée,
 * puis avec l'originale si le résultat est trop court (< 80 caractères).
 *
 * @param {string} base64Image - Image en base64
 * @param {string} mimeType - Type MIME de l'image (ex: 'image/jpeg')
 * @param {string} mistralApiKey - Clé API Mistral
 * @returns {Promise<{text: string, meta: {usedPreprocess: boolean, fallback: boolean, scoreOCR: number}}>} - Texte OCR et métadonnées
 */
async function ocrWithFallback(base64Image, mimeType, mistralApiKey) {
  // 1. Pré-traiter l'image si activé
  const preprocessedBase64 = await preprocessImageIfEnabled(base64Image);
  const usedPreprocess = preprocessedBase64 !== base64Image;

  // Préparer l'image data URL pour Mistral
  let base64Data = preprocessedBase64;
  if (preprocessedBase64.startsWith('data:')) {
    if (preprocessedBase64.includes(',')) {
      base64Data = preprocessedBase64.split(',')[1];
    }
  }
  const imageDataUrl = `data:${mimeType};base64,${base64Data}`;

  // 2. Tenter l'OCR avec l'image pré-traitée
  console.log('[OCR_FALLBACK] Tentative OCR avec image pré-traitée');
  console.log('[OCR_FALLBACK] Image data URL length:', imageDataUrl.length);
  console.log('[OCR_FALLBACK] MISTRAL_API_KEY present:', !!mistralApiKey, 'length:', mistralApiKey?.length);

  const abortController1 = new AbortController();
  const timeoutMs = 60000; // 60 secondes
  const timeoutId1 = setTimeout(() => {
    abortController1.abort();
  }, timeoutMs);

  try {
    console.log('[OCR_FALLBACK] Envoi requête Mistral attempt 1...');
    const ocrRes1 = await fetch(AI_CONFIG.mistralApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${mistralApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'mistral-large-latest',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Extrais le texte de cette ordonnance médicale française. Retourne uniquement le texte brut sans commentaire.' },
              {
                type: 'image_url',
                image_url: {
                  url: imageDataUrl
                }
              }
            ]
          }
        ]
      }),
      signal: abortController1.signal
    });

    clearTimeout(timeoutId1);

    if (ocrRes1.ok) {
      const ocrData1 = await ocrRes1.json();
      const text1 = ocrData1.choices?.[0]?.message?.content || '';
      const textLength1 = text1.trim().length;

      // Calculer le score OCR (basé sur la longueur, normalisé entre 0 et 1)
      // Score = min(1, longueur / 500) - considère 500 caractères comme excellent
      const scoreOCR1 = Math.min(1, textLength1 / 500);

      // Vérifier si le texte est suffisamment long
      if (text1 && textLength1 >= 80) {
        console.log('[OCR_FALLBACK] OCR pré-traité réussi, texte:', textLength1, 'caractères');
        return {
          text: text1,
          meta: {
            usedPreprocess: usedPreprocess,
            fallback: false,
            scoreOCR: scoreOCR1
          }
        };
      } else {
        console.log('[OCR_FALLBACK] OCR pré-traité trop court (', textLength1, 'caractères), fallback vers originale');
      }
    } else {
      // Si 429, propager l'erreur immédiatement (pas de fallback)
      if (ocrRes1.status === 429) {
        const errorText = await ocrRes1.text();
        const retryAfterHeader = ocrRes1.headers.get('retry-after');
        const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 30000;

        console.warn(`[OCR_FALLBACK] ❌ Rate limit Mistral (429), retryAfter: ${retryAfter}ms`);
        console.warn(`[OCR_FALLBACK] Response body:`, errorText);

        const error = new Error(`OCR Mistral rate limit: ${ocrRes1.status} - ${errorText}`);
        error.status = 429;
        error.statusCode = 429;
        error.retryAfter = retryAfter;
        error.retryAfterMs = retryAfter;

        throw error;
      }
      const errorBody = await ocrRes1.text();
      console.warn(`[OCR_FALLBACK] Erreur OCR pré-traité: status=${ocrRes1.status}, body:`, errorBody);
    }
  } catch (error) {
    clearTimeout(timeoutId1);
    if (error.name === 'AbortError') {
      console.warn('[OCR_FALLBACK] Timeout OCR pré-traité');
    } else {
      console.warn('[OCR_FALLBACK] Erreur OCR pré-traité:', error.message);
    }
  }

  // 3. Fallback : OCR avec l'image originale
  console.log('[OCR_FALLBACK] Tentative OCR avec image originale');

  let originalBase64Data = base64Image;
  if (base64Image.startsWith('data:')) {
    if (base64Image.includes(',')) {
      originalBase64Data = base64Image.split(',')[1];
    }
  }
  const originalImageDataUrl = `data:${mimeType};base64,${originalBase64Data}`;
  console.log('[OCR_FALLBACK] Original image data URL length:', originalImageDataUrl.length);

  const abortController2 = new AbortController();
  const timeoutId2 = setTimeout(() => {
    abortController2.abort();
  }, timeoutMs);

  try {
    console.log('[OCR_FALLBACK] Envoi requête Mistral attempt 2 (fallback)...');
    const ocrRes2 = await fetch(AI_CONFIG.mistralApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${mistralApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'mistral-large-latest',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Extrais le texte de cette ordonnance médicale française. Retourne uniquement le texte brut sans commentaire.' },
              {
                type: 'image_url',
                image_url: {
                  url: originalImageDataUrl
                }
              }
            ]
          }
        ]
      }),
      signal: abortController2.signal
    });

    clearTimeout(timeoutId2);

    if (!ocrRes2.ok) {
      const errorText = await ocrRes2.text();
      let providerStatus = ocrRes2.status;
      let isRateLimit = providerStatus === 429;
      let providerCode = null;

      try {
        const errBody = JSON.parse(errorText);
        providerCode = errBody?.code ?? errBody?.error?.code ?? null;
        if (providerCode === 1300 || (errBody?.message && String(errBody.message).includes('Rate limit exceeded'))) {
          isRateLimit = true;
          providerStatus = 429;
        }
      } catch (_) {
        if (errorText.includes('Rate limit exceeded')) {
          isRateLimit = true;
          providerStatus = 429;
        }
      }

      const retryAfterHeader = ocrRes2.headers.get('retry-after');
      const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : (isRateLimit ? 30000 : null);

      if (isRateLimit) {
        console.warn(`[OCR_FALLBACK] ❌ Rate limit Mistral (429 / code ${providerCode ?? 'n/a'}), retryAfter: ${retryAfter}ms`);
      } else {
        console.warn(`[OCR_FALLBACK] ❌ Erreur Mistral: status=${ocrRes2.status}`);
      }

      const error = new Error(`OCR Mistral failed: ${providerStatus} - ${errorText}`);
      error.status = providerStatus;
      error.statusCode = providerStatus;
      if (providerCode != null) {
        error.code = providerCode;
        error.errorCode = providerCode;
      }
      if (retryAfter) {
        error.retryAfter = retryAfter;
        error.retryAfterMs = retryAfter;
      }

      throw error;
    }

    const ocrData2 = await ocrRes2.json();
    const text2 = ocrData2.choices?.[0]?.message?.content || '';
    const textLength2 = text2.trim().length;

    // Calculer le score OCR
    const scoreOCR2 = Math.min(1, textLength2 / 500);

    console.log('[OCR_FALLBACK] OCR originale terminée, texte:', textLength2, 'caractères');
    return {
      text: text2,
      meta: {
        usedPreprocess: usedPreprocess,
        fallback: true,
        scoreOCR: scoreOCR2
      }
    };

  } catch (error) {
    clearTimeout(timeoutId2);
    if (error.name === 'AbortError') {
      console.warn('[OCR_FALLBACK] Timeout Mistral sur image originale');
    } else {
      console.warn('[OCR_FALLBACK] Erreur Mistral sur image originale:', error.message);
    }

    // OpenAI désactivé: pas de fallback Vision.
    throw new Error(`OCR failed - Mistral: ${error.message}`);
  }
}

/**
 * Transforme la réponse ordonnance pour le frontend :
 * - prescription[] → medicaments[]
 * - medicament → name
 * - Supprime les entrées vides
 * - Garantit un tableau propre
 *
 * @param {Object} normalized - Objet ordonnance normalisé
 * @returns {Object} - Objet transformé pour le frontend
 */
function transformOrdonnanceForFrontend(normalized) {
  // Créer une copie pour ne pas modifier l'original
  const transformed = { ...normalized };

  // Transformer prescription[] en medicaments[]
  if (Array.isArray(transformed.prescription)) {
    transformed.medicaments = transformed.prescription
      .map(item => {
        // Renommer "medicament" en "name"
        if (item && typeof item === 'object') {
          const { medicament, ...rest } = item;
          return {
            name: medicament || '',
            ...rest
          };
        }
        return null;
      })
      .filter(item => {
        // Supprimer les entrées vides
        if (!item) return false;
        // Garder seulement les entrées avec au moins un champ non vide
        return Object.values(item).some(val => val && val.toString().trim() !== '');
      });

    // Supprimer l'ancienne clé prescription
    delete transformed.prescription;
  } else {
    // Si prescription n'existe pas, créer un tableau vide
    transformed.medicaments = [];
  }

  // S'assurer que appointments est présent et bien formaté
  if (!Array.isArray(transformed.appointments)) {
    transformed.appointments = [];
  } else {
    // Appliquer les fallbacks aux appointments
    transformed.appointments = transformed.appointments.map(apt => {
      if (typeof apt === 'object' && apt !== null) {
        return {
          appointmentTitle: apt.appointmentTitle || 'Rendez-vous médical',
          doctorName: apt.doctorName || '',
          datetimeISO: apt.datetimeISO || '', // REQUIS pour créer un événement calendrier
          location: apt.location || ''
        };
      }
      return null;
    }).filter(apt => apt !== null);
  }

  return transformed;
}

// ===== ROUTES =====

// Route POST /api/ocr/handwritten - OCR manuscrit (photo d'ordonnance)
router.post('/api/ocr/handwritten', (req, res, next) => {
  // Log AVANT Multer pour confirmer que la route est atteinte
  console.log('✅ ===== ROUTE /api/ocr/handwritten ATTEINTE (AVANT MULTER) =====');
  console.log('📥 Méthode:', req.method);
  console.log('🔗 URL:', req.url);
  console.log('📋 Headers Content-Type:', req.headers['content-type']);
  console.log('📋 Content-Length:', req.headers['content-length']);
  next();
}, ocrUpload.any(), (req, res, next) => {
  // Log APRÈS Multer pour voir ce qui a été reçu
  console.log('✅ ===== APRÈS MULTER =====');
  console.log('📋 req.files:', req.files ? req.files.map(f => ({
    fieldname: f.fieldname,
    originalname: f.originalname,
    mimetype: f.mimetype,
    size: f.size
  })) : 'null');
  console.log('📋 req.files length:', req.files ? req.files.length : 0);
  console.log('📋 req.body keys:', Object.keys(req.body || {}));
  next();
}, async (req, res) => {
  try {
    // 1. Vérifier qu'un fichier a été uploadé (avec upload.any(), les fichiers sont dans req.files)
    if (!req.files || req.files.length === 0) {
      console.error('❌ ===== AUCUN FICHIER REÇU =====');
      console.error('📋 Body keys:', Object.keys(req.body || {}));
      console.error('📋 Files array:', req.files);
      return res.status(400).json({
        error: 'NO_FILE',
        message: 'Aucun fichier image fourni',
        received: {
          hasBody: !!req.body,
          bodyKeys: Object.keys(req.body || {}),
          hasFiles: !!req.files,
          filesCount: req.files ? req.files.length : 0
        }
      });
    }

    // 2. Récupérer le premier fichier reçu
    const uploadedFile = req.files[0];

    // Log du champ et du fichier reçu
    console.log('✅ ===== FICHIER REÇU ET VALIDÉ =====');
    console.log('🏷️  Nom du champ:', uploadedFile.fieldname);
    console.log('📄 Nom du fichier:', uploadedFile.originalname);
    console.log('📏 Taille:', uploadedFile.size, 'bytes');
    console.log('🏷️  Type MIME:', uploadedFile.mimetype);

    // 3. Vérifier que c'est bien une image
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(uploadedFile.mimetype)) {
      console.error('❌ Type de fichier invalide:', uploadedFile.mimetype);
      return res.status(400).json({
        error: 'INVALID_FILE_TYPE',
        message: 'Le fichier doit être une image (JPEG, PNG, WEBP)'
      });
    }

    // 4. Créer un FormData pour forwarder l'image vers n8n
    // Format requis par n8n pour le Binary Property "file"
    // n8n attend un champ multipart "file" avec le binaire de l'image
    const formData = new FormData();
    const blob = new Blob([uploadedFile.buffer], { type: uploadedFile.mimetype || 'image/jpeg' });
    formData.append('file', blob, uploadedFile.originalname || 'image.jpg');

    console.log('📤 ===== APPEL VERS WEBHOOK N8N OCR =====');
    console.log('🔗 URL du webhook:', N8N_OCR_WEBHOOK_URL);
    console.log('📋 Méthode: POST');
    console.log('📦 Taille du fichier à envoyer:', uploadedFile.size, 'bytes');

    // 4. Envoyer l'image au webhook n8n
    let n8nResponse;
    try {
      n8nResponse = await fetch(N8N_OCR_WEBHOOK_URL, {
        method: 'POST',
        body: formData
      });
    } catch (fetchError) {
      console.error('❌ ===== ERREUR LORS DE L\'APPEL VERS N8N =====');
      console.error('🔴 Erreur réseau:', fetchError.message);
      console.error('🔴 Stack:', fetchError.stack);
      return res.status(500).json({
        error: 'N8N_FETCH_ERROR',
        message: 'Erreur réseau lors de l\'appel vers le webhook n8n',
        details: fetchError.message
      });
    }

    console.log('📥 ===== RÉPONSE REÇUE DU WEBHOOK N8N =====');
    console.log('📊 Status HTTP:', n8nResponse.status);
    console.log('📊 Status Text:', n8nResponse.statusText);
    console.log('📋 Headers:', Object.fromEntries(n8nResponse.headers.entries()));

    // 5. Vérifier le status de la réponse
    if (!n8nResponse.ok) {
      const errorText = await n8nResponse.text();
      console.error('❌ ===== ERREUR DU WEBHOOK N8N =====');
      console.error('🔴 Status HTTP:', n8nResponse.status);
      console.error('🔴 Status Text:', n8nResponse.statusText);
      console.error('🔴 Message d\'erreur:', errorText);

      // Retourner 404 si n8n retourne 404, sinon 500
      const statusCode = n8nResponse.status === 404 ? 404 : (n8nResponse.status || 500);
      return res.status(statusCode).json({
        error: 'N8N_ERROR',
        message: 'Erreur lors du traitement OCR par n8n',
        n8nStatus: n8nResponse.status,
        n8nStatusText: n8nResponse.statusText,
        details: errorText
      });
    }

    // 6. Lire la réponse JSON de n8n
    let responseData;
    try {
      responseData = await n8nResponse.json();
      console.log('✅ ===== RÉPONSE OCR REÇUE AVEC SUCCÈS =====');
      console.log('📄 Type de réponse:', typeof responseData);
      console.log('📄 Clés de la réponse:', Object.keys(responseData || {}));
    } catch (jsonError) {
      console.error('❌ ===== ERREUR LORS DU PARSING JSON =====');
      console.error('🔴 Erreur:', jsonError.message);
      const rawText = await n8nResponse.text();
      console.error('🔴 Réponse brute:', rawText);
      return res.status(500).json({
        error: 'N8N_JSON_PARSE_ERROR',
        message: 'Erreur lors du parsing de la réponse JSON de n8n',
        details: jsonError.message,
        rawResponse: rawText
      });
    }

    // 7. Retourner la réponse JSON telle quelle au frontend
    console.log('✅ ===== ENVOI DE LA RÉPONSE AU FRONTEND =====');
    res.json(responseData);

  } catch (error) {
    console.error('❌ ===== ERREUR GÉNÉRALE LORS DU TRAITEMENT OCR =====');
    console.error('🔴 Erreur:', error.message);
    console.error('🔴 Stack:', error.stack);
    res.status(500).json({
      error: 'OCR_PROCESSING_ERROR',
      message: 'Erreur lors du traitement de l\'image OCR',
      details: error.message
    });
  }
});

// Route POST /api/ordonnances/create - Créer une ordonnance OCR manuscrite
router.post('/api/ordonnances/create', (req, res) => {
  console.log('📝 ===== CRÉATION D\'ORDONNANCE OCR MANUSCRITE =====');
  console.log('📥 Body reçu:', {
    source: req.body?.source,
    hasRawText: !!req.body?.rawText,
    rawTextLength: req.body?.rawText?.length,
    createdAt: req.body?.createdAt
  });

  try {
    // 1. Validation des données
    const { source, rawText, createdAt } = req.body;

    // Vérifier que source est "ocr_manuscrit"
    if (!source || source !== 'ocr_manuscrit') {
      console.error('❌ Source invalide:', source);
      return res.status(400).json({
        success: false,
        error: 'INVALID_SOURCE',
        message: 'Le champ source doit être "ocr_manuscrit"'
      });
    }

    // Vérifier que rawText n'est pas vide
    if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
      console.error('❌ rawText vide ou invalide');
      return res.status(400).json({
        success: false,
        error: 'INVALID_RAWTEXT',
        message: 'Le champ rawText est requis et ne peut pas être vide'
      });
    }

    // Valider createdAt (optionnel, utiliser la date actuelle si non fourni)
    let validCreatedAt = createdAt;
    if (!createdAt || !Date.parse(createdAt)) {
      console.log('⚠️  Date non fournie ou invalide, utilisation de la date actuelle');
      validCreatedAt = new Date().toISOString();
    }

    // 2. Créer l'ordonnance
    const ordonnance = {
      id: randomUUID(),
      source: 'ocr_manuscrit',
      rawText: rawText.trim(),
      status: 'a_recuperer',
      createdAt: validCreatedAt
    };

    // 3. Stocker l'ordonnance (en mémoire pour l'instant)
    ordonnances.push(ordonnance);

    console.log('✅ ===== ORDONNANCE CRÉÉE AVEC SUCCÈS =====');
    console.log('🆔 ID:', ordonnance.id);
    console.log('📄 Source:', ordonnance.source);
    console.log('📏 Longueur rawText:', ordonnance.rawText.length);
    console.log('📅 Créée le:', ordonnance.createdAt);
    console.log('📊 Total ordonnances:', ordonnances.length);

    // 4. Retourner la réponse
    res.status(201).json({
      success: true,
      ordonnance: ordonnance
    });

  } catch (error) {
    console.error('❌ ===== ERREUR LORS DE LA CRÉATION D\'ORDONNANCE =====');
    console.error('🔴 Erreur:', error.message);
    console.error('🔴 Stack:', error.stack);
    res.status(500).json({
      success: false,
      error: 'CREATION_ERROR',
      message: 'Erreur lors de la création de l\'ordonnance',
      details: error.message
    });
  }
});

// Route POST /api/ordonnance/ocr - Créer une ordonnance issue de l'OCR manuscrit
router.post('/api/ordonnance/ocr', async (req, res) => {
  console.log('[OCR ORD] POST /api/ordonnance/ocr appelée');

  try {
    // 1. Validation des données
    const { source, rawText, createdAt } = req.body;

    // Vérifier que rawText n'est pas vide
    if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
      console.error('[OCR ORD] ❌ rawText vide ou invalide');
      return res.status(400).json({
        success: false,
        error: 'INVALID_RAWTEXT',
        message: 'Le champ rawText est requis et ne peut pas être vide'
      });
    }

    // Valider createdAt (optionnel, utiliser la date actuelle si non fourni)
    let validCreatedAt = createdAt;
    if (!createdAt || !Date.parse(createdAt)) {
      validCreatedAt = new Date().toISOString();
    }

    // 2. Mapper le texte OCR brut vers les champs métier (déterministe)
    const structuredData = mapOcrToOrdonnanceFields(rawText);

    // 3. Créer l'ordonnance avec le format structuré standard via la fonction centrale
    // Les valeurs sont déjà garanties par mapOcrToOrdonnanceFields (pas de null/undefined)
    const ordonnance = createOrdonnance({
      source: source || 'ocr_manuscrit',
      rawText: rawText.trim(),
      doctorName: structuredData.doctorName,
      patientName: structuredData.patientName,
      medications: structuredData.medications,
      status: 'a_recuperer',
      createdAt: validCreatedAt
    });

    console.log('[ORDONNANCE] OCR visible dans Mes ordonnances');

    console.log('[OCR ORD] Ordonnance OCR créée avec succès');
    console.log('[OCR ORD] ID:', ordonnance.id);
    console.log('[OCR ORD] Status:', ordonnance.status);
    console.log('[OCR ORD] Médecin:', ordonnance.doctorName);
    console.log('[OCR ORD] Patient:', ordonnance.patientName);
    console.log('[OCR ORD] Médicaments:', ordonnance.medications.length);
    console.log('[OCR ORD] Total ordonnances dans le store:', ordonnances.length);

    // 5. Retourner la réponse
    res.status(200).json({
      success: true,
      ordonnance: ordonnance
    });

  } catch (error) {
    console.error('[OCR ORD] ❌ Erreur lors de la création:', error.message);
    res.status(500).json({
      success: false,
      error: 'CREATION_ERROR',
      message: 'Erreur lors de la création de l\'ordonnance',
      details: error.message
    });
  }
});

// Route POST /ocr-photo - OCR avec Mistral + Structuration IA avec OpenAI
//
// Variables d'environnement requises:
// - MISTRAL_API_KEY: Clé API Mistral pour l'OCR
// - OPENAI_API_KEY: Clé API OpenAI pour la structuration (optionnel, fallback déterministe si absent)
//
// Body attendu: { "image": "base64_string" } (JSON uniquement, pas multipart)
// Retourne: JSON structuré selon le schéma Medicalia strict
router.post('/ocr-photo', async (req, res) => {
  const t0 = Date.now();
  console.log('[OCR PHOTO] POST /ocr-photo appelée');

  // OpenAI désactivé: ne pas exiger OPENAI_API_KEY.

  const { base64 } = req.body ?? {};
  console.log("[OCR_PHOTO] body keys =", Object.keys(req.body ?? {}));
  console.log("[OCR_PHOTO] base64 type =", typeof base64, "len =", base64?.length ?? 0);

  if (!base64 || typeof base64 !== 'string' || base64.length <= 100) {
    return res.status(400).json({
      error: "INVALID_PAYLOAD",
      receivedKeys: Object.keys(req.body ?? {}),
      base64Type: typeof base64,
      base64Len: base64?.length ?? 0
    });
  }

  try {

    // Logs
    console.log("[OCR] base64 length =", base64.length);
    console.log("[OCR] request OK");

    console.log("[OCR-PHOTO] checkpoint A: base64 ok");

    // 1️⃣ OCR Mistral
    console.log('[OCR PHOTO] Appel OCR Mistral...');
    console.log("[OCR-PHOTO] checkpoint B: avant appel Mistral");
    const mistralApiKey = process.env.MISTRAL_API_KEY;
    if (!mistralApiKey) {
      console.error('[OCR PHOTO] ❌ MISTRAL_API_KEY non définie');
      const totalDuration = Date.now() - t0;
      console.log(`[OCR-PHOTO] checkpoint D: erreur MISSING_API_KEY - temps total: ${totalDuration}ms`);
      return res.status(500).json({
        success: false,
        error: 'MISSING_API_KEY',
        message: 'MISTRAL_API_KEY non configurée'
      });
    }

    // Supporter data URI: "data:image/jpeg;base64,...." -> strip le préfixe si présent
    let mimeType = 'image/jpeg';

    if (base64.startsWith('data:')) {
      const mimeMatch = base64.match(/data:([^;]+)/);
      if (mimeMatch) {
        mimeType = mimeMatch[1];
      }
    }

     // Utiliser ocrWithFallback qui gère le pré-traitement et le fallback automatiquement
    console.log("[OCR-PHOTO] checkpoint B: avant appel OCR avec fallback");
    console.log("[OCR-PHOTO] base64 length:", base64.length, "mimeType:", mimeType);
    let ocrResult;
    try {
      ocrResult = await ocrWithFallback(base64, mimeType, mistralApiKey);
    } catch (ocrError) {
      const totalDuration = Date.now() - t0;
      console.error('[OCR PHOTO] ❌ Erreur OCR complète:', {
        message: ocrError.message,
        status: ocrError.status || ocrError.statusCode,
        code: ocrError.code || ocrError.errorCode,
        retryAfter: ocrError.retryAfter || ocrError.retryAfterMs,
        stack: ocrError.stack?.split('\n')[0] // Première ligne de la stack
      });

      if (ocrError.message.includes('timeout')) {
        console.error('[OCR PHOTO] ❌ Timeout Mistral');
        console.log(`[OCR-PHOTO] checkpoint D: erreur MISTRAL_TIMEOUT - temps total: ${totalDuration}ms`);
        return res.status(504).json({
          success: false,
          error: 'MISTRAL_TIMEOUT',
          message: 'OCR Mistral trop long'
        });
      }
      console.error('[OCR PHOTO] ❌ Erreur OCR message:', ocrError.message);
      throw ocrError;
    }

    const { text, meta } = ocrResult;
    const t1 = Date.now();
    const mistralDuration = t1 - t0;
    console.log(`[OCR-PHOTO] checkpoint C: OCR terminé - temps écoulé: ${mistralDuration}ms`);
    console.log('[OCR-PHOTO] Métadonnées:', meta);

    if (!text || text.trim().length === 0) {
      console.warn('[OCR PHOTO] ⚠️ Texte OCR vide');
      const totalDuration = Date.now() - t0;
      console.log(`[OCR-PHOTO] checkpoint D: erreur EMPTY_OCR_TEXT - temps total: ${totalDuration}ms`);
      return res.status(400).json({
        success: false,
        error: 'EMPTY_OCR_TEXT',
        message: 'Aucun texte extrait de l\'image'
      });
    }

    console.log('[OCR PHOTO] Texte OCR extrait:', text.substring(0, 100) + '...');

    // 2️⃣ Structuration déterministe (OpenAI désactivé)
    console.log('[OCR PHOTO] Structuration déterministe (OpenAI désactivé)');
    const structured = analyzeOrdonnanceText(text);
    const normalized = normalizeOrdonnance(structured, text);
    normalized.meta = meta;
    const transformed = transformOrdonnanceForFrontend(normalized);
    const totalDuration = Date.now() - t0;
    console.log(`[OCR-PHOTO] checkpoint D: succès (déterministe) - temps total: ${totalDuration}ms`);
    return res.status(200).json(transformed);

  } catch (e) {
    console.error("[OCR] ERROR DÉTAILLÉE:", {
      message: e.message || String(e),
      status: e.status || e.statusCode,
      code: e.code || e.errorCode,
      retryAfter: e.retryAfter || e.retryAfterMs,
      name: e.name,
    });
    if (e.stack) {
      console.error("[OCR] Stack:", e.stack);
    }
    const totalDuration = Date.now() - t0;
    console.log(`[OCR-PHOTO] checkpoint D: erreur dans catch - temps total: ${totalDuration}ms`);

    // Retourner plus de détails pour le debug
    return res.status(500).json({
      error: "OCR_FAILED",
      details: e.message || String(e),
      code: e.code || e.errorCode || null,
      status: e.status || e.statusCode || 500
    });
  }
});

// Route POST /debug/base64-check - Vérifier que la base64 arrive correctement
router.post('/debug/base64-check', (req, res) => {
  try {
    const { base64 } = req.body;

    if (!base64 || typeof base64 !== 'string') {
      return res.status(400).json({
        error: 'INVALID_BASE64',
        message: 'Le champ base64 (string) est requis'
      });
    }

    return res.status(200).json({
      length: base64.length,
      prefix: base64.substring(0, 30)
    });
  } catch (e) {
    console.error("[DEBUG] ERROR", e.message || e);
    return res.status(500).json({
      error: "DEBUG_FAILED"
    });
  }
});

// Route POST /api/ordonnance/photo - Proxy vers n8n OCR (pas de logique OCR locale)
router.post('/api/ordonnance/photo', async (req, res) => {
  console.log('[ORD PHOTO] POST /api/ordonnance/photo appelée');

  try {
    const { image } = req.body;

    // Validation
    if (!image || typeof image !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'INVALID_IMAGE',
        message: 'Le champ image (base64) est requis'
      });
    }

    // Extraire le base64 pur (sans le préfixe data:image/...;base64,)
    let base64Data = image;
    if (base64Data.includes(',')) {
      base64Data = base64Data.split(',')[1];
    }

    // Détecter le type MIME depuis le préfixe si présent
    let mimeType = 'image/jpeg';
    if (image.startsWith('data:')) {
      const mimeMatch = image.match(/data:([^;]+)/);
      if (mimeMatch) {
        mimeType = mimeMatch[1];
      }
    }

    // Convertir le base64 en buffer
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Créer un FormData pour envoyer l'image à n8n
    const formData = new FormData();
    const blob = new Blob([imageBuffer], { type: mimeType });
    formData.append('file', blob, 'image.jpg');

    // Envoyer l'image au webhook n8n OCR
    console.log('[ORD PHOTO] Envoi vers n8n OCR');
    const n8nResponse = await fetch(N8N_OCR_WEBHOOK_URL, {
      method: 'POST',
      body: formData
    });

    if (!n8nResponse.ok) {
      const errorText = await n8nResponse.text();
      console.error('[ORD PHOTO] ❌ Erreur n8n:', n8nResponse.status, errorText);
      return res.status(n8nResponse.status || 500).json({
        success: false,
        error: 'N8N_OCR_ERROR',
        message: 'Erreur lors du traitement OCR par n8n',
        details: errorText
      });
    }

    // Récupérer la réponse brute de n8n (texte ou JSON)
    const rawText = await n8nResponse.text();
    console.log('[ORD PHOTO] Réponse brute n8n reçue');

    // Traiter la réponse OCR comme une STRING BRUTE sans parsing ni nettoyage
    // Ne pas parser, splitter, nettoyer ou modifier le texte OCR
    let ocrText = '';

    // Si rawText existe, l'utiliser directement comme string brute
    if (rawText) {
      // Tenter d'extraire depuis JSON si c'est du JSON, sinon utiliser rawText tel quel
      try {
        const parsed = JSON.parse(rawText);
        // Extraire le texte depuis les champs possibles, mais conserver l'intégralité
        const extracted = parsed.text || parsed.ocr || parsed.result;
        // Si un champ est trouvé, l'utiliser tel quel (string brute)
        ocrText = extracted ? extracted.toString() : rawText.toString();
      } catch {
        // Si ce n'est pas du JSON, utiliser rawText tel quel comme string brute
        ocrText = rawText.toString();
      }
    }

    // Validation SAFE : vérifier la longueur sans modifier le texte
    if (ocrText && ocrText.length > 0) {
      console.log('[ORD PHOTO] OCR length:', ocrText.length);
      console.log('[ORD PHOTO] Début OCR:', ocrText.slice(0, 200));
      console.log('[ORD PHOTO] Fin OCR:', ocrText.slice(-200));
    } else {
      console.log('[ORD PHOTO] n8n n\'a renvoyé aucun texte OCR');
      console.log('⚠️  [ORD PHOTO] OCR vide – aucune structuration possible');
      // Si OCR vide, retourner une structure vide
      return res.json({
        success: true,
        ordonnance: {
          medecin: {
            nom: '',
            specialite: '',
            contact: ''
          },
          patient: {
            nom: '',
            prenom: '',
            securite_sociale: ''
          },
          contenu: {
            lignes: []
          },
          medicaments: [],
          texte_brut: ''
        }
      });
    }

    // Étape de pré-structuration avec LLM (sans classification automatique)
    let structuredOrdonnance = null;
    // Récupérer la clé UNIQUEMENT via app.locals (source de vérité)
    const OPENAI_API_KEY = req.app.locals.OPENAI_API_KEY;

    // Log de diagnostic
    if (!OPENAI_API_KEY) {
      console.error('[ORD PHOTO] ❌ OPENAI_API_KEY absente (app.locals)');
      console.error('[ORD PHOTO] ❌ La pré-structuration IA ne sera pas exécutée');
    } else {
      console.log('[ORD PHOTO] ✅ OPENAI_API_KEY trouvée (app.locals, length:', OPENAI_API_KEY.length, ')');
    }

    if (OPENAI_API_KEY && ocrText.trim().length > 0) {
      console.log('[ORD PHOTO] Appel LLM pour pré-structuration...');
      try {
        const aiRes = await fetch(AI_CONFIG.openaiApiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            temperature: 0.1,
            messages: [
              {
                role: 'system',
                content: `Tu es un assistant médical.

À partir du texte OCR suivant, structure une ordonnance médicale française
en champs simples, sans jamais décider du type d'ordonnance.

RÈGLES STRICTES :
- Ne jamais inventer d'information
- Laisser les champs vides si absents
- Toujours retourner un JSON valide
- Ne jamais expliquer
- Ne jamais utiliser de Markdown
- Ne jamais classer l'ordonnance

FORMAT OBLIGATOIRE :

{
  "medecin": {
    "nom": "",
    "specialite": "",
    "contact": ""
  },
  "patient": {
    "nom": "",
    "prenom": "",
    "securite_sociale": ""
  },
  "contenu": {
    "lignes": []
  },
  "medicaments": [
    {
      "nom": "",
      "posologie": "",
      "duree": ""
    }
  ],
  "texte_brut": ""
}`
              },
              {
                role: 'user',
                content: `Texte OCR :
${ocrText}`
              }
            ],
            response_format: { type: 'json_object' }
          })
        });

        if (aiRes.ok) {
          const aiData = await aiRes.json();
          try {
            const content = aiData.choices[0].message.content;
            structuredOrdonnance = typeof content === 'string' ? JSON.parse(content) : content;
            // S'assurer que texte_brut contient ocrText
            structuredOrdonnance.texte_brut = ocrText;
            console.log('[ORD PHOTO] Pré-structuration LLM réussie');
            console.log('[ORD PHOTO] Pré-structuration IA exécutée');
          } catch (parseError) {
            console.error('[ORD PHOTO] ❌ Erreur parsing JSON LLM:', parseError.message);
          }
        } else {
          const errorText = await aiRes.text();
          console.error('[ORD PHOTO] ❌ Erreur LLM:', aiRes.status, errorText);
        }
      } catch (llmError) {
        console.error('[ORD PHOTO] ❌ Erreur lors de l\'appel LLM:', llmError.message);
      }
    } else {
      if (!OPENAI_API_KEY) {
        console.error('[ORD PHOTO] ❌ OPENAI_API_KEY absente (app.locals) - pré-structuration ignorée');
        console.error('[ORD PHOTO] ❌ Vérifiez que la clé est bien définie dans le fichier .env');
      } else if (ocrText.trim().length === 0) {
        console.warn('[ORD PHOTO] ⚠️ Texte OCR vide - pré-structuration ignorée');
      }
    }

    // Si la pré-structuration a échoué ou n'est pas disponible, créer une structure basique
    if (!structuredOrdonnance) {
      console.log('[ORD PHOTO] Utilisation d\'une structure basique (fallback)');
      structuredOrdonnance = {
        medecin: {
          nom: '',
          specialite: '',
          contact: ''
        },
        patient: {
          nom: '',
          prenom: '',
          securite_sociale: ''
        },
        contenu: {
          lignes: ocrText.split('\n').filter(line => line.trim().length > 0)
        },
        medicaments: [],
        texte_brut: ocrText
      };
    }

    // Retourner le JSON structuré au frontend
    console.log('[ORD PHOTO] JSON structuré renvoyé au frontend');
    return res.json({
      success: true,
      ordonnance: structuredOrdonnance
    });

  } catch (error) {
    console.error('[ORD PHOTO] ❌ Erreur:', error.message);
    console.error('[ORD PHOTO] Stack:', error.stack);
    res.status(500).json({
      success: false,
      error: 'OCR_FAILED',
      message: 'Erreur lors de l\'envoi vers n8n OCR',
      details: error.message
    });
  }
});

export default router;
