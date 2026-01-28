// ===== CONFIGURATION CENTRALISÉE =====
// Chargement et validation des variables d'environnement
// dotenv est géré dans src/config/env.ts (uniquement en DEV)
import { logEnvStatus } from './src/config/env.js';

console.log("✅ BOOT SIGNATURE __BUILD_CHECK");
console.log("🚀 Backend started");

// Logs sécurisés des variables d'environnement
logEnvStatus();

// Logs temporaires de diagnostic
console.log("🔥 STARTUP FILE:", import.meta.url);
console.log("🔥 ENV OPENAI_API_KEY LOADED:", !!process.env.OPENAI_API_KEY);

// Imports nécessaires pour le chemin du .env (après dotenv.config())
import path from 'path';
import { fileURLToPath } from 'url';

// Obtenir __dirname en ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Vérification CRITIQUE de OPENAI_API_KEY
console.log("🔥 ENV OPENAI_API_KEY RAW:", process.env.OPENAI_API_KEY);
if (!process.env.OPENAI_API_KEY) {
  throw new Error("❌ FATAL: OPENAI_API_KEY NON CHARGÉE AU DÉMARRAGE");
}

// Logs de vérification
console.log('ENV CHECK → cwd:', process.cwd());
console.log('ENV CHECK → OPENAI:', !!process.env.OPENAI_API_KEY);
if (process.env.OPENAI_API_KEY) {
  console.log('ENV CHECK → OPENAI_KEY length:', process.env.OPENAI_API_KEY.length);
  console.log('ENV CHECK → OPENAI_KEY starts with sk-:', process.env.OPENAI_API_KEY.startsWith('sk-'));
} else {
  console.error('ENV CHECK → ❌ OPENAI_API_KEY est ABSENTE - La pré-structuration IA ne fonctionnera pas');
}
console.log('ENV CHECK → MISTRAL:', !!process.env.MISTRAL_API_KEY);

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import { randomUUID, createHmac, createHash } from 'crypto';
import OpenAI from 'openai';
import { APP_CONFIG } from './src/config/env.js';
import { supabaseAdmin } from './src/lib/supabaseAdmin.js';

const app = express();
const PORT = APP_CONFIG.port;

// ===== WEBHOOK STRIPE (AVANT LES BODY PARSERS) =====
// Le webhook Stripe nécessite le body en raw pour vérifier la signature
// IMPORTANT: Cette route doit être montée AVANT express.json()
import { handleStripeWebhook } from './routes/billing.routes.js';
app.post('/billing/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
console.log('[BILLING] Webhook route mounted (POST /billing/webhook) - before body parsers');

// ===== ENDPOINT HEALTHZ GLOBAL =====
app.get("/healthz", (req, res) => {
  res.status(200).json({ ok: true, boot: "AI_SUMMARY_PATCH_V1" });
});

// ===== STOCKAGE DE LA CLÉ OPENAI DANS app.locals =====
// Charger la clé UNE FOIS au démarrage et la stocker dans app.locals
// pour garantir l'accès fiable dans toutes les routes
app.locals.OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
console.log('ENV CHECK → OPENAI (locals):', !!app.locals.OPENAI_API_KEY);

// Log SAFE pour confirmer la présence de la clé OpenAI sans l'afficher
const k = process.env.OPENAI_API_KEY;
console.log("[ENV] OPENAI_API_KEY present =", !!k, "len =", k ? k.length : 0, "prefix =", k ? k.slice(0, 10) : null);


// ===== CONFIGURATION DES BODY PARSERS AU TOUT DÉBUT =====
// CRITIQUE: Ces middlewares DOIVENT être placés AVANT tout autre middleware
// IMPORTANT: body-parser (ou sa configuration par défaut) causait PayloadTooLargeError (HTTP 413) avec les photos base64
// Solution: Utiliser UNIQUEMENT express.json et express.urlencoded avec limite de 25mb
// Les images OCR en base64 peuvent être très volumineuses (plusieurs MB)
// Aucun body-parser ne doit être utilisé dans le projet (ni import, ni app.use)
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));

// ===== MIDDLEWARE DE LOGGING GLOBAL =====
app.use((req, res, next) => {
  const startTime = Date.now();
  const method = req.method;
  const path = req.path;
  const contentType = req.headers['content-type'] || 'N/A';
  const userAgent = req.headers['user-agent'] || 'N/A';
  const ip = req.ip || req.connection.remoteAddress || 'N/A';

  // Intercepter la fin de la réponse pour logger le statusCode et la durée
  const originalSend = res.send;
  const originalJson = res.json;
  
  res.send = function(body) {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;
    
    console.log(`[${method}] ${path} - ${statusCode} - ${duration}ms - ${contentType} - ${userAgent} - ${ip}`);
    
    return originalSend.call(this, body);
  };
  
  res.json = function(body) {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;
    
    console.log(`[${method}] ${path} - ${statusCode} - ${duration}ms - ${contentType} - ${userAgent} - ${ip}`);
    
    return originalJson.call(this, body);
  };

  next();
});

// ===== ENDPOINT HEALTHZ GLOBAL =====
app.get("/healthz", (req, res) => {
  res.status(200).json({ ok: true, build: "AI_SUMMARY_V1" });
});

// URL du webhook n8n pour la structuration d'ordonnances
const N8N_WEBHOOK_URL = 'https://jordanconsultia.app.n8n.cloud/webhook/pdf-ordonnance';

// URL du webhook n8n pour l'OCR manuscrit
const N8N_OCR_WEBHOOK_URL = 'https://jordanconsultia.app.n8n.cloud/webhook/ocr-image';

// Log de vérification au démarrage pour confirmer que la route est enregistrée
console.log('🔍 Route POST /api/ocr/handwritten enregistrée');

// Configuration CORS
app.use(cors());

// ===== MIDDLEWARES D'AUTHENTIFICATION =====
import { authenticateSupabase } from './middlewares/auth.js';
import { requireProfileRole } from './middlewares/profileRole.js';

// Exporter les middlewares pour utilisation dans les routes
app.locals.authenticateSupabase = authenticateSupabase;
app.locals.requireProfileRole = requireProfileRole;

console.log('[AUTH] Middlewares d\'authentification Supabase chargés');

// ===== ROUTES AI SUMMARY (dash + underscore) =====
import aiSummaryRouter from './routes/aiSummary.routes.js';
app.use('/ai', aiSummaryRouter);
console.log('[AI_SUMMARY] routes mounted on /ai (medical-summary + medical_summary)');

// ===== ROUTES MEDS =====
import medsRouter from './routes/meds.routes.js';
app.use('/meds', medsRouter);
console.log('[MEDS] routes mounted on /meds (resolve-substances)');

// ===== ROUTES BILLING =====
// Le webhook est monté séparément avant les body parsers (voir plus haut)
// Les autres routes billing sont montées ici
import billingRouter from './routes/billing.routes.js';
app.use('/billing', billingRouter);
console.log('[BILLING] routes mounted (POST /billing/create-checkout-session)');

// ===== ROUTES DEBUG (DEV uniquement) =====
import debugRouter from './routes/debug.routes.js';
app.use('/debug', debugRouter);
console.log('[DEBUG] routes mounted (GET /debug/env - DEV only)');

// ===== ROUTES ORDONNANCES =====
import ordonnancesRouter from './routes/ordonnances.routes.js';
app.use('/ordonnances', ordonnancesRouter);
console.log('[ORDONNANCES] routes mounted (POST /ordonnances/:id/recovered)');

// ===== ROUTES DEVICES =====
import devicesRouter from './routes/devices.routes.js';
app.use('/devices', devicesRouter);
console.log('[DEVICES] routes mounted (POST /devices/heartbeat)');

// ===== ROUTES TREATMENTS =====
import treatmentsRouter from './routes/treatments.routes.js';
app.use('/treatments', treatmentsRouter);
console.log('[TREATMENTS] routes mounted (GET /treatments/active)');

// ===== ROUTES SUPPLEMENTS =====
import supplementsRouter from './routes/supplements.routes.js';
app.use('/supplements', supplementsRouter);
console.log('[SUPPLEMENTS] routes mounted (GET /supplements, POST /supplements, PATCH /supplements/:id, DELETE /supplements/:id)');

// ===== ROUTES CARE (Patient <-> Aidant) =====
import careRouter from './routes/care.routes.js';
app.use('/care', careRouter);
console.log('[CARE] routes mounted (POST /care/invite, POST /care/accept, POST /care/revoke)');

// ===== ROUTES INVITES =====
import invitesRouter from './routes/invites.routes.js';
app.use('/', invitesRouter); // Routes: /profiles/:profileId/invites et /invites/accept
console.log('[INVITES] routes mounted (POST /profiles/:profileId/invites, POST /invites/accept)');

// Fonction pour lister les routes montées
function logRegisteredRoutes() {
  console.log('[ROUTES] Routes enregistrées:');
  const routes = [];
  
  function processStack(stack, prefix = '') {
    if (!stack || !Array.isArray(stack)) return;
    
    stack.forEach((middleware) => {
      if (middleware.route) {
        // Route directe
        const methods = Object.keys(middleware.route.methods).map(m => m.toUpperCase());
        const path = prefix + middleware.route.path;
        methods.forEach(method => {
          routes.push({ method, path });
        });
      } else if (middleware.name === 'router' && middleware.handle && middleware.handle.stack) {
        // Routeur monté - extraire le préfixe depuis regexp
        let routerPrefix = '';
        if (middleware.regexp) {
          const regexSource = middleware.regexp.source;
          // Extraire le préfixe du regex (ex: "^\\/ai" -> "/ai")
          const match = regexSource.match(/\^\\\/([^\\]+)/);
          if (match) {
            routerPrefix = '/' + match[1];
          }
        }
        processStack(middleware.handle.stack, prefix + routerPrefix);
      }
    });
  }
  
  if (app._router && app._router.stack) {
    processStack(app._router.stack);
  }
  
  // Afficher les routes
  routes.forEach(route => {
    console.log(`[ROUTES] ${route.method} ${route.path}`);
  });
  
  // Vérification explicite des routes AI Summary
  const hasMedicalSummaryDash = routes.some(r => r.path === '/ai/medical-summary' && (r.method === 'GET' || r.method === 'POST'));
  const hasMedicalSummaryUnderscore = routes.some(r => r.path === '/ai/medical_summary' && (r.method === 'GET' || r.method === 'POST'));
  const hasMedicalSummaryHealthDash = routes.some(r => r.path === '/ai/medical-summary/health' && r.method === 'GET');
  const hasMedicalSummaryHealthUnderscore = routes.some(r => r.path === '/ai/medical_summary/health' && r.method === 'GET');
  
  console.log('[ROUTES] ✅ AI Summary routes check:');
  console.log(`[ROUTES]   POST /ai/medical-summary: ${hasMedicalSummaryDash ? '✅' : '❌'}`);
  console.log(`[ROUTES]   POST /ai/medical_summary: ${hasMedicalSummaryUnderscore ? '✅' : '❌'}`);
  console.log(`[ROUTES]   GET /ai/medical-summary/health: ${hasMedicalSummaryHealthDash ? '✅' : '❌'}`);
  console.log(`[ROUTES]   GET /ai/medical_summary/health: ${hasMedicalSummaryHealthUnderscore ? '✅' : '❌'}`);
}

// Middleware de logging pour diagnostiquer les routes (temporaire pour debug)
app.use((req, res, next) => {
  // Logger uniquement les requêtes vers /api/ocr pour ne pas polluer les logs
  if (req.path.includes('/api/ocr') || req.path.includes('/ocr')) {
    console.log('🔍 ===== REQUÊTE REÇUE =====');
    console.log('📥 Méthode:', req.method);
    console.log('🔗 Path:', req.path);
    console.log('🔗 URL complète:', req.url);
    console.log('📋 Query params:', req.query);
  }
  next();
});

// Stockage en mémoire pour les ordonnances (à remplacer par une vraie base de données en production)
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

// Configuration de multer pour gérer l'upload en mémoire
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // Limite de 10MB
  }
});

// Configuration multer pour POST /ocr-photo - Accepte plusieurs fieldnames
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 }
});

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

// Route GET /
app.get('/', (req, res) => {
  res.send('BACKEND OK');
});

// Routes silencieuses pour éviter les 404 parasites
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// Route GET /ping
app.get('/ping', (req, res) => {
  console.log('PING OK');
  res.status(200).json({ status: 'OK' });
});

// Route GET /__build - Build signature endpoint
app.get("/__build", (req, res) => {
  res.json({ ok: true, build: "__BUILD_CHECK" });
});

// Route GET /health - Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    timestamp: Date.now(),
    serverBuild: 'AI_SUMMARY_V2_INLINE'
  });
});

// Route GET /version - Version info endpoint
app.get('/version', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'pdf-backend',
    serverBuild: 'AI_SUMMARY_V2_INLINE',
    timestamp: Date.now(),
    passportSecretLoaded: Boolean(process.env.PASSPORT_QR_SECRET),
    qrSecretLoaded: Boolean(process.env.QR_SECRET)
  });
});

// Route GET /billing/plan - Récupérer le plan utilisateur (mock)
// Documentation:
// - Endpoint simple pour préparer l'intégration future de la facturation
// - Retourne actuellement un plan hardcodé "FREE"
// - Pas d'authentification pour l'instant (sera ajoutée plus tard)
// - Headers no-store pour éviter la mise en cache
// - Plus tard: intégration avec auth + store receipts (App Store/Play Store)
app.get('/billing/plan', (req, res) => {
  // Headers de cache: no-store pour éviter la mise en cache
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  
  // Plan mock hardcodé (sera remplacé par une vraie logique plus tard)
  res.status(200).json({
    plan: 'FREE'
  });
});

// Route POST /push/register-token - Enregistrer un token push Expo/EAS (stub)
// Documentation:
// - Route préparatoire pour l'enregistrement des tokens push Expo/EAS
// - Actuellement retourne un stub {ok: true} sans traitement réel
// - Ne pas activer côté UI tant qu'on n'a pas de dev build + credentials Expo
// - Body attendu (pour préparer l'avenir):
//   {
//     userId: string,  // ID de l'utilisateur
//     token: string    // Token push Expo (ExpoPushToken)
//   }
// - Plus tard: stocker le token en base de données, associer à userId, gérer les mises à jour
app.post('/push/register-token', (req, res) => {
  console.log('[PUSH] POST /push/register-token appelée (stub)');
  
  // Log léger des données reçues (pour debug, sans exposer le token complet)
  const userId = req.body?.userId;
  const token = req.body?.token;
  const tokenPrefix = token && typeof token === 'string' && token.length >= 8 
    ? token.substring(0, 8) + '...' 
    : 'invalid';
  
  console.log(`[PUSH] userId: ${userId || 'missing'}, token: ${tokenPrefix}`);
  
  // Stub: retourner {ok: true} sans traitement réel
  // TODO: Implémenter la logique réelle quand on aura:
  // - Dev build Expo avec credentials configurés
  // - Base de données pour stocker les tokens
  // - Authentification pour valider userId
  res.status(200).json({
    ok: true
  });
});

// Route GET /beacon - Beacon endpoint (silencieux pour éviter 404)
app.get('/beacon', (req, res) => {
  res.status(204).end();
});

// Route POST /extract
app.post('/extract', upload.single('file'), (req, res) => {
  // Retourner une réponse factice pour tester l'upload
  res.json({ text: 'PDF bien reçu' });
});

// Route POST /analyze-ordonnance-test
app.post('/analyze-ordonnance-test', (req, res) => {
  console.log('TEST BACKEND OK');
  res.json({ status: 'OK', message: 'Backend reachable' });
});

// Route POST /analyze-ordonnance
// Expect multipart field: file
app.post('/analyze-ordonnance', upload.single('file'), async (req, res) => {
  const traceId = randomUUID();
  console.log(`[ANALYZE_ORDONNANCE][${traceId}] Début de l'analyse`);

  try {
    // ===== VALIDATIONS AVANT ANALYSE =====
    
    // 1. Validation: fichier requis
    if (!req.file) {
      console.log(`[ANALYZE_ORDONNANCE][${traceId}] ❌ Fichier manquant`);
      return res.status(400).json({
        ok: false,
        error: 'MISSING_FILE',
        traceId
      });
    }

    // 2. Validation: fichier non vide
    if (req.file.size === 0) {
      console.log(`[ANALYZE_ORDONNANCE][${traceId}] ❌ Fichier vide (size=0)`);
      return res.status(400).json({
        ok: false,
        error: 'EMPTY_FILE',
        traceId
      });
    }

    // 3. Validation: profile_id requis
    const profileId = req.body?.profile_id || req.query?.profile_id;
    if (!profileId || (typeof profileId === 'string' && profileId.trim() === '')) {
      console.log(`[ANALYZE_ORDONNANCE][${traceId}] ❌ profile_id manquant`);
      return res.status(400).json({
        ok: false,
        error: 'MISSING_PROFILE_ID',
        traceId
      });
    }

    // ===== LOGS SERVEUR DÉTAILLÉS =====
    console.log(`[ANALYZE_ORDONNANCE][${traceId}] Content-Type: ${req.headers['content-type'] || 'non défini'}`);
    console.log(`[ANALYZE_ORDONNANCE][${traceId}] Fichier: originalname="${req.file.originalname}", mimetype="${req.file.mimetype}", size=${req.file.size} bytes`);
    console.log(`[ANALYZE_ORDONNANCE][${traceId}] profile_id: ${profileId}`);

    // 4. Validation: type PDF
    if (req.file.mimetype !== 'application/pdf') {
      console.log(`[ANALYZE_ORDONNANCE][${traceId}] ❌ Type de fichier invalide: ${req.file.mimetype}`);
      return res.status(400).json({
        ok: false,
        error: 'INVALID_FILE_TYPE',
        message: 'Type de fichier invalide (PDF requis)',
        traceId
      });
    }

    // 5. Extraire le texte du PDF
    let extractedText;
    try {
      const pdfData = await pdfParse(req.file.buffer);
      extractedText = pdfData.text.trim();
    } catch (error) {
      console.error(`[ANALYZE_ORDONNANCE][${traceId}] ❌ Erreur extraction PDF:`, error?.stack || error);
      return res.status(500).json({
        ok: false,
        error: 'ANALYZE_ORDONNANCE_FAILED',
        message: error?.message || 'Erreur lors de l\'extraction PDF',
        traceId
      });
    }

    // 6. Validation: texte extrait non vide
    if (!extractedText || extractedText.length === 0) {
      console.log(`[ANALYZE_ORDONNANCE][${traceId}] ❌ Aucun texte extrait du PDF`);
      return res.status(400).json({
        ok: false,
        error: 'EMPTY_EXTRACTED_TEXT',
        message: 'Aucun texte extrait du PDF',
        traceId
      });
    }

    // Log du texte brut extrait du PDF
    console.log("===== TEXTE PDF BRUT =====");
    console.log(extractedText);
    console.log("==========================");

    // 6. Structurer le texte en sections médicales explicites
    const structuredText = structureText(extractedText);
    console.log("===== TEXTE STRUCTURÉ =====");
    console.log(structuredText);
    console.log("============================");

    // 7. Appeler le webhook n8n (provider OCR/LLM)
    const n8nData = { text: structuredText };
    let n8nResponse;
    try {
      n8nResponse = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(n8nData)
      });
    } catch (error) {
      console.error(`[ANALYZE_ORDONNANCE][${traceId}] ❌ Erreur appel n8n (réseau):`, error?.stack || error);
      return res.status(500).json({
        ok: false,
        error: 'ANALYZE_ORDONNANCE_FAILED',
        message: error?.message || 'Erreur lors de l\'appel au service d\'analyse',
        traceId
      });
    }

    if (!n8nResponse.ok) {
      const errBody = await n8nResponse.text();
      console.error(`[ANALYZE_ORDONNANCE][${traceId}] ❌ n8n provider error: status=${n8nResponse.status}, message=${errBody || n8nResponse.statusText}`);
      return res.status(500).json({
        ok: false,
        error: 'ANALYZE_ORDONNANCE_FAILED',
        message: `Service d'analyse indisponible (${n8nResponse.status})`,
        traceId
      });
    }

    // 8. Lire la réponse brute de n8n
    const rawText = await n8nResponse.text();
    if (!rawText || rawText.trim() === "") {
      console.log(`[ANALYZE_ORDONNANCE][${traceId}] ❌ Réponse vide du service d'analyse`);
      return res.status(500).json({
        ok: false,
        error: 'ANALYZE_ORDONNANCE_FAILED',
        message: 'Réponse vide du service d\'analyse',
        traceId
      });
    }

    // 9. Parser la réponse JSON de n8n
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      console.error(`[ANALYZE_ORDONNANCE][${traceId}] ❌ Erreur parsing réponse n8n:`, e?.stack || e);
      return res.status(500).json({
        ok: false,
        error: 'ANALYZE_ORDONNANCE_FAILED',
        message: 'Réponse invalide du service d\'analyse',
        traceId
      });
    }

    if (!parsed.result) {
      console.log(`[ANALYZE_ORDONNANCE][${traceId}] ❌ Champ result manquant dans la réponse`);
      return res.status(500).json({
        ok: false,
        error: 'ANALYZE_ORDONNANCE_FAILED',
        message: 'Champ result manquant dans la réponse',
        traceId
      });
    }

    let finalObject;
    try {
      finalObject = JSON.parse(parsed.result);
    } catch (e) {
      console.error(`[ANALYZE_ORDONNANCE][${traceId}] ❌ Erreur parsing result:`, e?.stack || e);
      return res.status(500).json({
        ok: false,
        error: 'ANALYZE_ORDONNANCE_FAILED',
        message: 'Format de résultat invalide',
        traceId
      });
    }

    if (typeof finalObject === 'string') {
      try {
        finalObject = JSON.parse(finalObject);
      } catch (e) {
        console.error(`[ANALYZE_ORDONNANCE][${traceId}] ❌ Erreur parsing result (string):`, e?.stack || e);
        return res.status(500).json({
          ok: false,
          error: 'ANALYZE_ORDONNANCE_FAILED',
          message: 'Format de résultat invalide',
          traceId
        });
      }
    }

    // 10. Transformer la réponse n8n au format Medicalia standard et stocker l'ordonnance
    const ordonnanceData = {
      source: 'pdf',
      rawText: extractedText,
      doctorName: finalObject.meta?.prescripteur?.nom || 
                  finalObject.prescripteur?.nom || 
                  finalObject.doctorName || 
                  null,
      patientName: finalObject.patient?.nom || 
                   finalObject.patientName || 
                   null,
      medications: [],
      status: 'a_recuperer',
      createdAt: new Date().toISOString()
    };

    // Transformer les médicaments
    if (finalObject.medicaments && Array.isArray(finalObject.medicaments)) {
      ordonnanceData.medications = finalObject.medicaments.map(med => ({
        name: med.nom || med.name || '',
        dosage: med.posologie || med.dosage || '',
        frequency: med.frequence || med.frequency || '',
        duration: med.duree || med.duration || null
      }));
    } else if (finalObject.medications && Array.isArray(finalObject.medications)) {
      ordonnanceData.medications = finalObject.medications.map(med => ({
        name: med.name || '',
        dosage: med.dosage || '',
        frequency: med.frequency || '',
        duration: med.duration || null
      }));
    }

    // Créer et stocker l'ordonnance PDF dans le store principal
    const ordonnance = createOrdonnance(ordonnanceData);
    console.log('[PDF ORD] Ordonnance PDF stockée dans le store principal');

    // 11. Retourner directement l'objet JSON final au client
    console.log(`[ANALYZE_ORDONNANCE][${traceId}] ✅ Analyse terminée avec succès`);
    res.json(finalObject);

  } catch (error) {
    console.error(`[ANALYZE_ORDONNANCE][${traceId}] ❌ Erreur générale:`, error?.stack || error);
    return res.status(500).json({
      ok: false,
      error: 'ANALYZE_ORDONNANCE_FAILED',
      message: error?.message || 'unknown',
      traceId
    });
  }
});

// Route GET /test-n8n
app.get('/test-n8n', async (req, res) => {
  try {
    const testData = {
      text: 'Dr Jean Dupont\nOrdonnance pour Monsieur Martin\nAmoxicilline 1g 1 comprimé matin et soir pendant 7 jours\nDoliprane 1000mg si douleur'
    };

    console.log('➡️ Appel n8n...');

    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(testData)
    });

    const rawText = await response.text();

    console.log("⬅️ Réponse brute n8n :", rawText);

    if (!rawText || rawText.trim() === "") {
      return res.status(500).json({
        error: "N8N_EMPTY_RESPONSE"
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      return res.status(500).json({
        error: "N8N_INVALID_JSON",
        raw: rawText
      });
    }

    // Extraire et parser le champ result qui contient une chaîne JSON
    if (!parsed.result) {
      return res.status(500).json({
        error: "N8N_MISSING_RESULT",
        raw: parsed
      });
    }

    let finalObject;
    try {
      finalObject = JSON.parse(parsed.result);
    } catch (e) {
      return res.status(500).json({
        error: "INVALID_JSON_FROM_N8N",
        raw: parsed.result
      });
    }

    // Vérifier que finalObject est bien un objet et non une string
    if (typeof finalObject === 'string') {
      try {
        finalObject = JSON.parse(finalObject);
      } catch (e) {
        return res.status(500).json({
          error: "INVALID_JSON_FROM_N8N",
          raw: finalObject
        });
      }
    }

    console.log("FINAL JSON SENT TO CLIENT", finalObject);

    // Retourner UNIQUEMENT l'objet JSON parsé (sans la clé "result")
    res.json(finalObject);

  } catch (error) {
    console.error('❌ Erreur lors de l\'appel n8n:', error);
    res.status(500).json({ 
      error: 'Erreur lors de l\'appel n8n',
      message: error.message 
    });
  }
});

// Configuration Multer spécifique pour l'OCR manuscrit (isolée des autres routes)
const ocrUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // Limite de 10MB
  }
});

// Route POST /api/ocr/handwritten - OCR manuscrit (photo d'ordonnance)
app.post('/api/ocr/handwritten', (req, res, next) => {
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
app.post('/api/ordonnances/create', (req, res) => {
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

// Route POST /api/ordonnance/ocr - Créer une ordonnance issue de l'OCR manuscrit
app.post('/api/ordonnance/ocr', async (req, res) => {
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

// Route GET /api/ordonnances - Récupérer toutes les ordonnances (PDF et OCR)

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
  
  const abortController1 = new AbortController();
  const timeoutMs = 60000; // 60 secondes
  const timeoutId1 = setTimeout(() => {
    abortController1.abort();
  }, timeoutMs);
  
  try {
    const ocrRes1 = await fetch('https://api.mistral.ai/v1/chat/completions', {
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
      console.warn('[OCR_FALLBACK] Erreur OCR pré-traité:', ocrRes1.status);
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
  
  const abortController2 = new AbortController();
  const timeoutId2 = setTimeout(() => {
    abortController2.abort();
  }, timeoutMs);
  
  try {
    const ocrRes2 = await fetch('https://api.mistral.ai/v1/chat/completions', {
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
      throw new Error(`OCR Mistral failed: ${ocrRes2.status} - ${errorText}`);
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
      throw new Error('OCR Mistral timeout après 60 secondes');
    }
    throw error;
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

// Route POST /ocr-photo - OCR avec Mistral + Structuration IA avec OpenAI
// 
// Variables d'environnement requises:
// - MISTRAL_API_KEY: Clé API Mistral pour l'OCR
// - OPENAI_API_KEY: Clé API OpenAI pour la structuration (optionnel, fallback déterministe si absent)
//
// Body attendu: { "image": "base64_string" } (JSON uniquement, pas multipart)
// Retourne: JSON structuré selon le schéma Medicalia strict
app.post('/ocr-photo', async (req, res) => {
  const t0 = Date.now();
  console.log('[OCR PHOTO] POST /ocr-photo appelée');
  
  // Vérifier que OPENAI_API_KEY est présente et valide
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.length < 20) {
    console.log("[OCR_PHOTO] Missing/invalid OPENAI_API_KEY, len =", process.env.OPENAI_API_KEY?.length ?? 0);
    return res.status(500).json({ error: "OPENAI_API_KEY_MISSING_OR_INVALID" });
  }
  
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
    let ocrResult;
    try {
      ocrResult = await ocrWithFallback(base64, mimeType, mistralApiKey);
    } catch (ocrError) {
      const totalDuration = Date.now() - t0;
      if (ocrError.message.includes('timeout')) {
        console.error('[OCR PHOTO] ❌ Timeout Mistral');
        console.log(`[OCR-PHOTO] checkpoint D: erreur MISTRAL_TIMEOUT - temps total: ${totalDuration}ms`);
        return res.status(504).json({
          success: false,
          error: 'MISTRAL_TIMEOUT',
          message: 'OCR Mistral trop long'
        });
      }
      console.error('[OCR PHOTO] ❌ Erreur OCR:', ocrError.message);
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

    // 2️⃣ IA Structuration avec OpenAI
    console.log('[OCR PHOTO] Appel structuration OpenAI...');
    // Utiliser EXCLUSIVEMENT app.locals.OPENAI_API_KEY (lue au démarrage)
    const OPENAI_KEY = req.app.locals.OPENAI_API_KEY;
    if (!OPENAI_KEY) {
      console.error('[OCR PHOTO] ❌ OPENAI_API_KEY absente (app.locals)');
      // Fallback: utiliser la fonction déterministe
      console.log('[OCR PHOTO] ⚠️ Utilisation de la fonction déterministe (fallback)');
      const structured = analyzeOrdonnanceText(text);
      const normalized = normalizeOrdonnance(structured, text);
      // Ajouter les métadonnées OCR
      normalized.meta = meta;
      // Transformer pour le frontend
      const transformed = transformOrdonnanceForFrontend(normalized);
      const totalDuration = Date.now() - t0;
      console.log(`[OCR-PHOTO] checkpoint D: succès (fallback déterministe) - temps total: ${totalDuration}ms`);
      return res.status(200).json(transformed);
    }

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o', // Utiliser gpt-4o au lieu de gpt-4.1 (qui n'existe pas)
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: `Tu es un assistant médical expert en ordonnances françaises. 
Retourne UNIQUEMENT un JSON valide respectant EXACTEMENT ce schéma :

{
  "doctor": {
    "name": "",
    "speciality": "",
    "rpps": ""
  },
  "patient": {
    "name": "",
    "birthDate": ""
  },
  "prescription": [
    {
      "medicament": "",
      "dosage": "",
      "posologie": "",
      "duration": ""
    }
  ],
  "additionalInstructions": "",
  "rdv": {
    "appointmentTitle": "",
    "doctorName": null,
    "datetimeISO": null,
    "location": null,
    "note": null
  },
  "issueDate": "",
  "confidenceScore": 0.0,
  "source": "OCR"
}

Règles strictes:
- Ne jamais inventer d'information
- Laisser les champs vides ("") ou null si inconnus
- Extraire chaque médicament individuellement
- Pour rdv (un seul rendez-vous par ordonnance):
  * appointmentTitle: acte/motif principal NETTOYÉ (ex: "Échographie T2", "Consultation cardiologie", "Prise de sang"). 
    - Retirer les mots inutiles: "rendez-vous", "RDV", "chez", "à", "le", "pour", etc.
    - Garder court (max ~50 caractères)
    - Majuscules/minuscules correctes (première lettre majuscule)
    - Si rien trouvé: laisser vide (sera "Rendez-vous médical" en fallback)
  * doctorName: nom du praticien si présent dans le texte (ex: "Dr Martin", "Docteur Dupont", "Pr. Bernard").
    - Normaliser: "Dr <Nom>" si un nom est trouvé (retirer "Docteur", "Pr", "Professeur" et garder juste le nom avec "Dr")
    - Si aucun nom de praticien trouvé: null (NE PAS utiliser le nom du docteur prescripteur)
    - Ne pas inventer
  * datetimeISO: date + heure au format ISO 8601 (ex: "2024-01-15T14:30:00+01:00").
    - Parser date + heure si présentes
    - Si seule la date est présente: mettre heure à 09:00 (ex: "2024-01-15T09:00:00+01:00")
    - Si aucune date: null (le frontend demandera à l'utilisateur de compléter)
  * location: cabinet/hôpital/adresse si détecté (ex: "Cabinet médical", "Hôpital Pitié-Salpêtrière", "15 Rue de la Paix, 75001 Paris").
    - Si absent: null
  * note: informations complémentaires optionnelles (pas affichées par défaut).
    - Si absent: null
- Calculer confidenceScore entre 0 et 1 selon la clarté du texte
- Retourner UNIQUEMENT le JSON, sans texte supplémentaire`
          },
          {
            role: 'user',
            content: text
          }
        ],
        response_format: { type: 'json_object' } // Forcer le format JSON
      })
    });

    if (!aiRes.ok) {
      const errorText = await aiRes.text();
      console.error('[OCR PHOTO] ❌ Erreur OpenAI:', aiRes.status, errorText);
      // Fallback: utiliser la fonction déterministe
      console.log('[OCR PHOTO] ⚠️ Utilisation de la fonction déterministe (fallback)');
      const structured = analyzeOrdonnanceText(text);
      const normalized = normalizeOrdonnance(structured, text);
      // Ajouter les métadonnées OCR
      normalized.meta = meta;
      // Transformer pour le frontend
      const transformed = transformOrdonnanceForFrontend(normalized);
      const totalDuration = Date.now() - t0;
      console.log(`[OCR-PHOTO] checkpoint D: succès (fallback déterministe) - temps total: ${totalDuration}ms`);
      return res.status(200).json(transformed);
    }

    const aiData = await aiRes.json();
    let structured;

    try {
      // Essayer de parser le contenu JSON
      const content = aiData.choices[0].message.content;
      structured = typeof content === 'string' ? JSON.parse(content) : content;
    } catch (parseError) {
      console.error('[OCR PHOTO] ❌ Erreur parsing JSON OpenAI:', parseError.message);
      // Fallback: utiliser la fonction déterministe
      console.log('[OCR PHOTO] ⚠️ Utilisation de la fonction déterministe (fallback)');
      structured = analyzeOrdonnanceText(text);
    }

    // Valider le format de sortie
    if (!structured.doctor || !structured.patient || !Array.isArray(structured.prescription)) {
      console.warn('[OCR PHOTO] ⚠️ Format OpenAI invalide, utilisation du fallback');
      structured = analyzeOrdonnanceText(text);
    }

    // Normaliser l'ordonnance au format canonique strict
    const normalized = normalizeOrdonnance(structured, text);
    
    // Ajouter les métadonnées OCR
    normalized.meta = meta;
    
    // Transformer pour le frontend
    const transformed = transformOrdonnanceForFrontend(normalized);

    console.log('[OCR PHOTO] ✅ Structuration terminée');
    console.log('[OCR PHOTO] Score de confiance:', normalized.confidenceScore);
    console.log('[OCR PHOTO] Médecin:', normalized.doctor.name);
    console.log('[OCR PHOTO] Patient:', normalized.patient.name);
    console.log('[OCR PHOTO] Médicaments:', transformed.medicaments.length);

    const totalDuration = Date.now() - t0;
    console.log(`[OCR-PHOTO] checkpoint D: succès - temps total: ${totalDuration}ms`);
    return res.status(200).json(transformed);

  } catch (e) {
    console.error("[OCR] ERROR", e.message || e);
    if (e.stack) {
      console.error("[OCR] Stack:", e.stack);
    }
    const totalDuration = Date.now() - t0;
    console.log(`[OCR-PHOTO] checkpoint D: erreur dans catch - temps total: ${totalDuration}ms`);
    return res.status(500).json({ 
      error: "OCR_FAILED"
    });
  }
});

// Route POST /debug/base64-check - Vérifier que la base64 arrive correctement
app.post('/debug/base64-check', (req, res) => {
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
app.post('/api/ordonnance/photo', async (req, res) => {
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
        const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
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

// Route POST /api/ordonnance/finalize - Finaliser l'enregistrement d'une ordonnance selon le type
app.post('/api/ordonnance/finalize', (req, res) => {
  console.log('[FINALIZE] POST /api/ordonnance/finalize appelée');
  
  console.log("[FINALIZE] body keys", Object.keys(req.body || {}));
  console.log("[FINALIZE] has structured", !!req.body?.structured);
  console.log("[FINALIZE] has output", !!req.body?.output);

  try {
    const { structured: inputStructured, output, type } = req.body;

    // Accepter plusieurs formats d'input
    let structured = inputStructured || output || req.body;

    // Détecter si c'est le format A (doctor, patient, prescription)
    const isFormatA = structured && 
                      typeof structured === 'object' &&
                      (structured.doctor || structured.patient || structured.prescription);

    if (isFormatA) {
      console.log('[FINALIZE] Format A détecté - Conversion vers schéma Medicalia');
      
      // Convertir du format A vers le schéma Medicalia attendu
      const doctorObj = structured.doctor || {};
      const patientObj = structured.patient || {};
      const prescriptionArray = Array.isArray(structured.prescription) ? structured.prescription : [];
      
      // Extraire le nom du médecin (peut être une string ou un objet avec name)
      const doctorName = typeof doctorObj === 'string' 
        ? doctorObj 
        : (doctorObj.name || '');
      
      // Extraire le nom du patient (peut être une string ou un objet avec name)
      const patientName = typeof patientObj === 'string'
        ? patientObj
        : (patientObj.name || '');
      
      // Convertir les prescriptions en médicaments
      const medicaments = prescriptionArray.map(pres => ({
        nom: pres.medicament || pres.name || pres.nom || '',
        dosage: pres.dosage || '',
        posologie: pres.posologie || pres.frequency || pres.frequence || '',
        duree: pres.duration || pres.duree || null
      }));
      
      // Construire le schéma Medicalia
      structured = {
        medecin: doctorName,
        patient: patientName,
        medicaments: medicaments,
        texte_brut: structured.rawText || structured.text || ''
      };
      
      console.log('[FINALIZE] Conversion terminée:', {
        medecin: structured.medecin,
        patient: structured.patient,
        medicamentsCount: structured.medicaments.length
      });
    }

    // Validation
    if (!structured || typeof structured !== 'object') {
      return res.status(400).json({
        error: 'INVALID_STRUCTURED',
        expected: 'Un objet JSON structuré avec les champs suivants: { structured: { medecin, patient, medicaments, texte_brut } } OU { output: { doctor, patient, prescription, rawText } } OU directement un objet avec { doctor, patient, prescription } (format A)',
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

    // Extraire les données structurées
    const medecin = structured.medecin || '';
    const patient = structured.patient || '';
    const medicaments = structured.medicaments || [];
    const texteBrut = structured.texte_brut || '';

    // Transformer les médicaments au format attendu par createOrdonnance
    const medications = medicaments.map(med => ({
      name: med.nom || '',
      dosage: med.dosage || '',
      frequency: med.posologie || '',
      duration: med.duree || null
    }));

    // Extraire le rdv structuré (nouveau format) ou appointments (ancien format)
    let rdv = null;
    let appointments = [];
    
    // Normaliser d'abord avec normalizeOrdonnance pour avoir le format standardisé
    const normalized = normalizeOrdonnance(structured, texteBrut);
    
    // Utiliser rdv si présent (nouveau format)
    if (normalized.rdv && typeof normalized.rdv === 'object') {
      rdv = normalized.rdv;
      appointments = [rdv]; // Compatibilité
    } else if (Array.isArray(normalized.appointments) && normalized.appointments.length > 0) {
      // Ancien format: prendre le premier appointment
      const apt = normalized.appointments[0];
      rdv = {
        appointmentTitle: apt.appointmentTitle || 'Rendez-vous médical',
        doctorName: apt.doctorName || null,
        datetimeISO: apt.datetimeISO || null,
        location: apt.location || null,
        note: apt.note || null
      };
      appointments = [rdv];
    }

    // Préparer les données de l'ordonnance
    const ordonnanceData = {
      source: 'ocr_manuscrit',
      rawText: texteBrut,
      doctorName: medecin || null,
      patientName: patient || null,
      medications: medications,
      appointments: appointments, // Compatibilité (tableau)
      rdv: rdv, // Nouveau format (objet unique)
      status: type === 'RENDEZ_VOUS' ? 'rdv_a_planifier' : 'a_recuperer',
      createdAt: new Date().toISOString(),
      type: type // Ajouter le type à l'ordonnance
    };

    // Créer l'ordonnance
    const ordonnance = createOrdonnance(ordonnanceData);

    // Gérer les actions spécifiques selon le type
    if (type === 'MEDICAMENT') {
      console.log('[FINALIZE] Type MEDICAMENT - Préparation workflow notifications/calendrier');
      // TODO: Préparer le workflow notifications / calendrier
      // Exemple : appeler un webhook n8n pour les notifications
      // Exemple : créer des événements calendrier pour les prises de médicaments
    } else if (type === 'RENDEZ_VOUS') {
      console.log('[FINALIZE] Type RENDEZ_VOUS - Préparation orientation Doctolib');
      // Marquer l'ordonnance comme RDV
      ordonnance.isRdv = true;
      
      // Log des appointments pour debug
      if (appointments.length > 0) {
        appointments.forEach((apt, idx) => {
          console.log(`[FINALIZE] Appointment ${idx + 1}:`, {
            title: apt.appointmentTitle,
            doctor: apt.doctorName,
            datetime: apt.datetimeISO || 'MANQUANT (demander à l\'utilisateur de compléter)',
            location: apt.location || 'Non spécifié'
          });
          
          // Avertir si datetimeISO est absent (requis pour calendrier)
          if (!apt.datetimeISO || apt.datetimeISO.trim() === '') {
            console.warn(`[FINALIZE] ⚠️ Appointment ${idx + 1} sans datetimeISO - ne pourra pas créer d'événement calendrier`);
          }
        });
      }
      
      // TODO: Préparer l'orientation Doctolib
      // Exemple : générer un lien Doctolib ou appeler une API Doctolib
    }

    console.log('[FINALIZE] Ordonnance finalisée avec succès');
    console.log('[FINALIZE] ID:', ordonnance.id);
    console.log('[FINALIZE] Type:', type);
    console.log('[FINALIZE] Status:', ordonnance.status);

    // Retourner l'ordonnance créée
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

/**
 * Routes pour l'analyse d'ordonnances:
 * 
 * POST /api/ordonnance/analyze
 *   - Attend JSON: { rawText: string }
 *   - Analyse un texte brut d'ordonnance déjà extrait
 *   - Retourne: { output: analyzedData }
 * 
 * POST /api/ordonnance/ocr
 *   - Attend JSON: { source, rawText, createdAt? }
 *   - Crée une ordonnance issue de l'OCR manuscrit
 * 
 * POST /analyze-ordonnance
 *   - Attend multipart/form-data avec champ "file" (PDF)
 *   - Extrait le texte du PDF et l'analyse
 *   - Retourne l'objet JSON structuré
 */
// Route POST /api/ordonnance/analyze - Analyser un texte brut d'ordonnance
app.post('/api/ordonnance/analyze', (req, res) => {
  const traceId = randomUUID();
  console.log(`[ANALYZE][${traceId}] POST /api/ordonnance/analyze appelée`);

  try {
    // Vérifier que le Content-Type n'est pas multipart/form-data
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      console.log(`[ANALYZE][${traceId}] ❌ Content-Type multipart/form-data reçu (attendu: application/json)`);
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
        message: 'Le champ rawText est requis et ne peut pas être vide',
        traceId
      });
    }

    // Analyser le texte brut
    const analyzedData = analyzeOrdonnanceText(rawText);

    console.log(`[ANALYZE][${traceId}] ✅ Analyse terminée`);
    console.log(`[ANALYZE][${traceId}] Score de confiance:`, analyzedData.confidenceScore);
    console.log(`[ANALYZE][${traceId}] Médecin:`, analyzedData.doctor.name);
    console.log(`[ANALYZE][${traceId}] Patient:`, analyzedData.patient.name);
    console.log(`[ANALYZE][${traceId}] Prescriptions:`, analyzedData.prescription.length);

    // Retourner le JSON strict enveloppé dans { output: ... }
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

app.get('/api/ordonnances', (req, res) => {
  console.log('[ORD LIST] GET /api/ordonnances - Récupération de toutes les ordonnances');
  console.log('[ORD LIST] Nombre d\'ordonnances retournées :', ordonnances.length);
  
  // Retourner toutes les ordonnances sans filtre par source
  res.status(200).json({
    success: true,
    ordonnances: ordonnances,
    count: ordonnances.length
  });
});

// ===== AI MEDICAL SUMMARY (synthèse factuelle) =====
const validateAiSummaryBody = (body) => {
  if (!body || typeof body !== 'object') return 'BODY_MISSING';
  if (!body.personal || typeof body.personal !== 'object') return 'PERSONAL_MISSING';
  if (!Array.isArray(body.ordonnances)) return 'ORDONNANCES_MISSING';
  return null;
};

/**
 * Construit un texte consolidé (facts only) à partir de personal + ordonnances
 */
function buildFactsText(personal, ordonnances) {
  // Nettoyer les labels d'actions (limiter à 280 caractères et garder uniquement la partie après "ORDONNANCE" si présent)
  const cleanActionLabel = (label) => {
    if (!label || typeof label !== 'string') return '';
    let cleaned = label;
    // Garder uniquement la partie après "ORDONNANCE" si présent
    const ordonnanceIndex = cleaned.indexOf('ORDONNANCE');
    if (ordonnanceIndex !== -1) {
      cleaned = cleaned.substring(ordonnanceIndex + 'ORDONNANCE'.length).trim();
    }
    // Limiter à 280 caractères
    if (cleaned.length > 280) {
      cleaned = cleaned.substring(0, 280) + '...';
    }
    return cleaned;
  };

  const factsText = `
IDENTITE:
- Nom: ${personal.nom ?? "?"}
- Prenom: ${personal.prenom ?? "?"}
- Age: ${personal.age ?? "?"}

ALERTES:
- Allergies: ${personal.allergies?.join(", ") ?? "Aucune"}

ORDONNANCES:
${ordonnances.map(o => {
  const cleanedActions = (o.actions || []).map(a => {
    const cleanedLabel = cleanActionLabel(a.label);
    return `${a.type ?? "autre"} - ${cleanedLabel} - scheduledAt=${a.scheduledAt ?? "null"}`;
  });
  
  return `
- Ordonnance ${o.id} (${o.category ?? o.type ?? "?"}) date=${o.date ?? "?"}
  Medecin: ${o.medecin?.prenom ?? ""} ${o.medecin?.nom ?? ""} ${o.medecin?.profession ?? ""}
  Medicaments: ${(o.medicaments||[]).map(m=>`${m.medicament ?? m.nom ?? "?"} ${m.dosage ?? ""} ${m.posologie ?? m.frequence ?? ""} ${m.duration ?? m.duree ?? ""}`).join(" | ") || "Aucun"}
  Actions: ${cleanedActions.join(" | ") || "Aucune"}
`;
}).join("\n")}
`;

  return factsText.trim();
}

/**
 * Détecte le type d'action depuis une ordonnance
 */
function detectActionType(ord) {
  const label = generateActionLabel(ord).toLowerCase();
  
  if (label.includes('radio') || label.includes('scanner') || label.includes('irm') || label.includes('échographie') || label.includes('imagerie')) {
    return 'imagerie';
  }
  if (label.includes('prise de sang') || label.includes('analyse') || label.includes('laboratoire')) {
    return 'analyse';
  }
  if (label.includes('consultation') || label.includes('rdv') || label.includes('rendez-vous')) {
    return 'consultation';
  }
  return 'autre';
}

/**
 * Génère un label pour une action
 */
function generateActionLabel(ord) {
  // Si l'ordonnance contient des médicaments, essayer d'en déduire l'action
  if (Array.isArray(ord.medicaments) && ord.medicaments.length > 0) {
    const firstMed = ord.medicaments[0];
    if (firstMed.nom) {
      return firstMed.nom;
    }
  }
  
  // Sinon, utiliser un label générique
  if (ord.type === 'rendez_vous') {
    return 'Rendez-vous médical';
  }
  
  return 'Action médicale';
}

/**
 * Calcule le statut d'un traitement selon dates/durée
 */
function calculateTreatmentStatus(traitement, ordDate) {
  if (!ordDate) return 'INCONNU';
  
  const startDate = new Date(ordDate);
  if (isNaN(startDate.getTime())) return 'INCONNU';
  
  if (traitement.duree) {
    // Parser la durée (ex: "7 jours", "1 mois")
    const dureeMatch = traitement.duree.match(/(\d+)\s*(jour|jours|mois|semaine|semaines)/i);
    if (dureeMatch) {
      const value = parseInt(dureeMatch[1]);
      const unit = dureeMatch[2].toLowerCase();
      
      let daysToAdd = 0;
      if (unit.includes('jour')) daysToAdd = value;
      else if (unit.includes('semaine')) daysToAdd = value * 7;
      else if (unit.includes('mois')) daysToAdd = value * 30;
      
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + daysToAdd);
      const now = new Date();
      
      if (now < startDate) return 'PLANIFIE';
      if (now > endDate) return 'TERMINE';
      return 'EN_COURS';
    }
  }
  
  // Si pas de durée, vérifier si la date est passée
  const now = new Date();
  if (now < startDate) return 'PLANIFIE';
  // Si date passée sans durée, on ne peut pas savoir
  return 'INCONNU';
}

/**
 * Extrait le texte de la réponse OpenAI de manière robuste
 */
function extractTextFromOpenAIResponse(resp) {
  // Responses API: resp.output_text
  if (resp && typeof resp.output_text === "string" && resp.output_text.trim()) {
    return resp.output_text.trim();
  }

  // Responses API alternative: resp.output[].content[].text
  try {
    const out = resp?.output;
    if (Array.isArray(out)) {
      for (const item of out) {
        const content = item?.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            const t = c?.text;
            if (typeof t === "string" && t.trim()) return t.trim();
          }
        }
      }
    }
  } catch (_) {}

  // Chat Completions: resp.choices[0].message.content
  const chatText = resp?.choices?.[0]?.message?.content;
  if (typeof chatText === "string" && chatText.trim()) return chatText.trim();

  // fallback: empty string
  return "";
}

/**
 * Génère un résumé texte simple via OpenAI SDK
 */
async function generateSummaryText(factsText, openaiApiKey) {
  const MAX_RETRIES = 2;
  const TIMEOUT_MS = 60000;

  const systemPrompt = `Tu fais une synthèse factuelle des ordonnances et infos déclarées. Aucun diagnostic, aucun conseil médical, aucune interprétation clinique. Tu peux reformuler et regrouper. Statut organisationnel possible: PLANIFIE si scheduledAt présent, sinon A_FAIRE. N'invente rien. Réponds uniquement par un texte simple en français, 2 à 5 phrases max.`;

  const userPrompt = `Fais une synthèse simple et utile à partir de ces faits:\n\n${factsText}`;

  const client = new OpenAI({ apiKey: openaiApiKey });

  // Retry logic
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      console.log(`[AI_SUMMARY] Appel OpenAI (tentative ${attempt}/${MAX_RETRIES + 1})...`);
      
      // Gérer le timeout avec Promise.race
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('OpenAI API timeout after 60 seconds'));
        }, TIMEOUT_MS);
      });

      const completion = await Promise.race([
        client.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0.1,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        }),
        timeoutPromise
      ]);

      // Logs de debug pour la structure de réponse
      console.log("[AI_SUMMARY] OpenAI resp keys:", Object.keys(completion || {}));
      console.log("[AI_SUMMARY] has output_text:", typeof completion?.output_text, "output_len:", completion?.output_text?.length || 0);
      console.log("[AI_SUMMARY] has output array:", Array.isArray(completion?.output), "output_items:", completion?.output?.length || 0);
      console.log("[AI_SUMMARY] has choices:", Array.isArray(completion?.choices), "choices_len:", completion?.choices?.length || 0);

      // Extraire le texte de manière robuste
      const summary = extractTextFromOpenAIResponse(completion);
        
      if (!summary || summary.length === 0) {
        throw new Error('OpenAI response missing or invalid summary text');
      }

      console.log('[AI_SUMMARY] Résumé texte reçu avec succès');
      return summary;

    } catch (error) {
      lastError = error;
      console.warn(`[AI_SUMMARY] Tentative ${attempt} échouée:`, error.message);
      if (attempt <= MAX_RETRIES) {
        const delay = attempt * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

const aiSummaryHandler = async (req, res) => {
  console.log('[AI_SUMMARY] HIT', req.method, req.originalUrl);
  
  try {
    // Validation
    const err = validateAiSummaryBody(req.body);
    if (err) {
      return res.status(400).json({ ok: false, error: 'INVALID_BODY', detail: err });
    }

    // Récupérer la clé OpenAI
    const OPENAI_KEY = req.app.locals.OPENAI_API_KEY;
    if (!OPENAI_KEY) {
      console.error('[AI_SUMMARY] ❌ OPENAI_API_KEY absente');
      return res.status(500).json({ 
        ok: false, 
        error: 'OPENAI_API_KEY_MISSING',
        message: 'Clé API OpenAI non configurée'
      });
    }

    // Construire le texte consolidé (facts only)
    const factsText = buildFactsText(req.body.personal, req.body.ordonnances);
    
    console.log("[AI_SUMMARY] factsText length =", factsText.length);

    // Générer le résumé texte via OpenAI
    const summary = await generateSummaryText(factsText, OPENAI_KEY);
    
    if (!summary || summary.trim().length === 0) {
      console.error('[AI_SUMMARY] ❌ Empty summary after extraction');
      return res.status(500).json({
        ok: false,
        error: 'EMPTY_SUMMARY',
        message: 'Le résumé généré est vide'
      });
    }
    
    console.log("[AI_SUMMARY] ✅ summaryLength =", summary.length);

    // Retourner avec ok:true et summary
    return res.status(200).json({
      ok: true,
      summary: summary,
      serverBuild: "AI_SUMMARY_OPENAI_V2",
      serverTime: new Date().toISOString()
    });

  } catch (error) {
    console.error('[AI_SUMMARY] Erreur:', error.message);
    if (error.stack) {
      console.error('[AI_SUMMARY] Stack:', error.stack);
    }
    
    return res.status(500).json({
      ok: false,
      error: 'OPENAI_ERROR',
      message: 'Erreur lors de la génération du résumé médical'
    });
  }
};

/**
 * Formate un complément alimentaire pour le résumé médical
 * 
 * @param {Object} supplement - Complément à formater
 * @returns {string} - Texte formaté pour le résumé
 */
function formatSupplementForSummary(supplement) {
  const parts = [];
  
  // Nom (title)
  if (supplement.title) {
    parts.push(supplement.title);
  }
  
  // Fréquence (schedule)
  if (supplement.schedule && typeof supplement.schedule === 'object') {
    const schedule = supplement.schedule;
    const freqParts = [];
    
    if (schedule.mode === 'daily') {
      freqParts.push('quotidien');
    } else if (schedule.mode === 'weekly') {
      const days = schedule.daysOfWeek || [];
      const dayNames = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
      const dayLabels = days.map(d => dayNames[d]).filter(Boolean);
      if (dayLabels.length > 0) {
        freqParts.push(`hebdomadaire (${dayLabels.join(', ')})`);
      } else {
        freqParts.push('hebdomadaire');
      }
    } else if (schedule.mode === 'monthly') {
      freqParts.push(`mensuel (jour ${schedule.dayOfMonth || '?'})`);
    }
    
    if (schedule.times && Array.isArray(schedule.times) && schedule.times.length > 0) {
      freqParts.push(`à ${schedule.times.join(', ')}`);
    }
    
    if (freqParts.length > 0) {
      parts.push(`Fréquence: ${freqParts.join(' ')}`);
    }
  }
  
  // Période (start_date -> end_date)
  if (supplement.start_date || supplement.end_date) {
    const periodParts = [];
    if (supplement.start_date) {
      const startDate = new Date(supplement.start_date);
      if (!isNaN(startDate.getTime())) {
        periodParts.push(`depuis ${startDate.toLocaleDateString('fr-FR')}`);
      }
    }
    if (supplement.end_date) {
      const endDate = new Date(supplement.end_date);
      if (!isNaN(endDate.getTime())) {
        periodParts.push(`jusqu'au ${endDate.toLocaleDateString('fr-FR')}`);
      }
    }
    if (periodParts.length > 0) {
      parts.push(`Période: ${periodParts.join(' ')}`);
    }
  }
  
  // Notes
  if (supplement.notes && supplement.notes.trim()) {
    parts.push(`Notes: ${supplement.notes.trim()}`);
  }
  
  return parts.length > 0 ? parts.join(' | ') : supplement.title || 'Complément';
}

/**
 * Récupère les compléments actifs pour un profile_id
 * 
 * @param {string} userId - ID de l'utilisateur
 * @param {string} profileId - ID du profil (optionnel)
 * @returns {Promise<Array>} - Liste des compléments
 */
async function fetchActiveSupplements(userId, profileId) {
  if (!supabaseAdmin) {
    console.warn('[AI_SUMMARY_V2] Supabase admin non disponible, skip compléments');
    return [];
  }
  
  try {
    let query = supabaseAdmin
      .from('supplements')
      .select('*')
      .eq('owner_user_id', userId)
      .in('status', ['active', 'paused']); // Actifs et paused
    
    if (profileId) {
      query = query.eq('profile_id', profileId);
    }
    
    const { data: supplements, error } = await query;
    
    if (error) {
      console.warn('[AI_SUMMARY_V2] Erreur récupération compléments:', error.message);
      return [];
    }
    
    return supplements || [];
  } catch (error) {
    console.warn('[AI_SUMMARY_V2] Erreur récupération compléments:', error.message);
    return [];
  }
}

// ===== AI MEDICAL SUMMARY V2 HANDLER (hoistée pour éviter TDZ) =====
async function aiSummaryV2Handler(req, res) {
  console.log('[AI_SUMMARY_V2] HIT', req.method, req.originalUrl);
  
  try {
    // Validation
    const err = validateAiSummaryBody(req.body);
    if (err) {
      return res.status(400).json({ ok: false, error: 'INVALID_BODY', detail: err });
    }

    const personal = req.body.personal;
    const ordonnances = req.body.ordonnances;
    const healthProfile = req.body.healthProfile; // Optionnel
    const profileId = req.body.profile_id || req.query.profile_id; // Optionnel
    
    // Récupérer l'utilisateur si authentifié (pour récupérer les compléments)
    const userId = req.userId || req.user?.id;
    
    // Sécurité: ne pas logger healthProfile en clair
    const healthProfileHash = healthProfile 
      ? createHash('sha256').update(JSON.stringify(healthProfile)).digest('hex').substring(0, 8)
      : null;
    if (healthProfile) {
      console.log(`[AI_SUMMARY_V2] healthProfile reçu (hash: ${healthProfileHash})`);
    }
    
    // Récupérer les compléments alimentaires actifs si userId et profileId disponibles
    let supplements = [];
    if (userId && profileId) {
      try {
        supplements = await fetchActiveSupplements(userId, profileId);
        console.log(`[AI_SUMMARY_V2] ${supplements.length} complément(s) récupéré(s) pour profile_id=${profileId}`);
      } catch (suppError) {
        console.warn('[AI_SUMMARY_V2] Erreur récupération compléments (non bloquant):', suppError.message);
        supplements = [];
      }
    } else {
      if (!userId) {
        console.log('[AI_SUMMARY_V2] userId non disponible, skip compléments');
      }
      if (!profileId) {
        console.log('[AI_SUMMARY_V2] profile_id non fourni, skip compléments');
      }
    }
    
    // IMPORTANT: Si un cache est implémenté, la clé doit inclure healthProfile et supplements pour éviter un mauvais cache
    // Exemple de cacheKey: userId + ":" + hash(ordonnances) + ":" + (healthProfile.updatedAt || hash(healthProfile)) + ":" + hash(supplements)
    // Cela garantit que le résumé se régénère si le HealthProfile ou les compléments changent
    // const cacheKey = `${userId}:${hashOrdonnances}:${healthProfile?.updatedAt || hashHealthProfile}:${hashSupplements}`;
    
    // Construire factsText pour OpenAI (SANS identité)
    const factsParts = [];
    
    // Allergies (depuis personal, pas depuis healthProfile - ce sont des sources différentes)
    if (Array.isArray(personal.allergies) && personal.allergies.length > 0) {
      factsParts.push(`Allergies (ordonnances): ${personal.allergies.join(', ')}`);
    }
    
    // Médicaments
    const medLines = [];
    ordonnances.forEach(ord => {
      if (Array.isArray(ord.medicaments) && ord.medicaments.length > 0) {
        ord.medicaments.forEach(med => {
          const medParts = [];
          if (med.medicament || med.nom) medParts.push(med.medicament || med.nom);
          if (med.dosage) medParts.push(med.dosage);
          if (med.posologie || med.frequence) medParts.push(med.posologie || med.frequence);
          if (med.duration || med.duree) medParts.push(med.duration || med.duree);
          if (medParts.length > 0) {
            medLines.push(`- ${medParts.join(' - ')}`);
          }
        });
      }
    });
    if (medLines.length > 0) {
      factsParts.push('Médicaments:');
      factsParts.push(...medLines);
    }
    
    // Actions/RDV
    const actionLines = [];
    ordonnances.forEach(ord => {
      if (Array.isArray(ord.actions) && ord.actions.length > 0) {
        ord.actions.forEach(action => {
          let label = action.label || '';
          
          // Extraire une phrase courte du label
          if (label.includes('Faire réaliser')) {
            const index = label.indexOf('Faire réaliser');
            label = label.substring(index).trim();
          } else if (label.includes('ORDONNANCE')) {
            const index = label.indexOf('ORDONNANCE');
            label = label.substring(index + 'ORDONNANCE'.length).trim();
          }
          
          // Limiter à 180 caractères
          if (label.length > 180) {
            label = label.substring(0, 180) + '...';
          }
          
          const scheduledAt = action.scheduledAt;
          const status = scheduledAt ? 'PLANIFIE' : 'A_FAIRE';
          
          if (label) {
            actionLines.push(`- ${label} (${status})`);
          }
        });
      }
    });
    if (actionLines.length > 0) {
      factsParts.push('Actions/RDV:');
      factsParts.push(...actionLines);
    }
    
    // Ajouter TOUT le contexte HealthProfile (déclaratif) si présent
    if (healthProfile && typeof healthProfile === 'object') {
      factsParts.push('\n=== CONTEXTE DÉCLARÉ PAR L\'UTILISATEUR (HEALTHPROFILE) ===');
      factsParts.push('IMPORTANT: Ces informations sont déclaratives, ne pas inférer. Utiliser uniquement ce qui est présent.');
      
      // Allergies
      if (healthProfile.allergies && Array.isArray(healthProfile.allergies) && healthProfile.allergies.length > 0) {
        factsParts.push(`Allergies: ${healthProfile.allergies.join(', ')}`);
      }
      
      // Maladies chroniques (chronicConditions ou chronicDiseases)
      const chronicConditions = healthProfile.chronicConditions || healthProfile.chronicDiseases;
      if (Array.isArray(chronicConditions) && chronicConditions.length > 0) {
        factsParts.push(`Maladies chroniques: ${chronicConditions.join(', ')}`);
      }
      
      // Traitements (treatments ou longTermTreatments)
      const treatments = healthProfile.treatments || healthProfile.longTermTreatments;
      if (Array.isArray(treatments) && treatments.length > 0) {
        const treatmentLines = treatments.map(t => {
          if (typeof t === 'string') return t;
          if (typeof t === 'object') {
            const parts = [];
            if (t.name) parts.push(t.name);
            if (t.dosage) parts.push(`(${t.dosage})`);
            if (t.frequency) parts.push(`- ${t.frequency}`);
            return parts.join(' ');
          }
          return '';
        }).filter(Boolean);
        if (treatmentLines.length > 0) {
          factsParts.push(`Traitements en cours: ${treatmentLines.join(' ; ')}`);
        }
      }
      
      // Chirurgies (surgeries)
      if (healthProfile.surgeries && Array.isArray(healthProfile.surgeries) && healthProfile.surgeries.length > 0) {
        const surgeryLines = healthProfile.surgeries.map(s => {
          if (typeof s === 'string') return s;
          if (typeof s === 'object') {
            const parts = [];
            if (s.name) parts.push(s.name);
            if (s.date) parts.push(`(${s.date})`);
            return parts.join(' ');
          }
          return '';
        }).filter(Boolean);
        if (surgeryLines.length > 0) {
          factsParts.push(`Chirurgies: ${surgeryLines.join(' ; ')}`);
        }
      }
      
      // Contacts médecins (doctorContacts)
      if (healthProfile.doctorContacts && Array.isArray(healthProfile.doctorContacts) && healthProfile.doctorContacts.length > 0) {
        const doctorLines = healthProfile.doctorContacts.map(doc => {
          if (typeof doc === 'string') return doc;
          if (typeof doc === 'object') {
            const parts = [];
            if (doc.name) parts.push(doc.name);
            if (doc.specialty) parts.push(`(${doc.specialty})`);
            if (doc.phone) parts.push(`- ${doc.phone}`);
            return parts.join(' ');
          }
          return '';
        }).filter(Boolean);
        if (doctorLines.length > 0) {
          factsParts.push(`Contacts médecins: ${doctorLines.join(' ; ')}`);
        }
      }
      
      // Contact d'urgence (emergencyContact)
      if (healthProfile.emergencyContact) {
        const contact = healthProfile.emergencyContact;
        const contactParts = [];
        if (contact.name) contactParts.push(contact.name);
        if (contact.phone) contactParts.push(contact.phone);
        if (contact.relationship) contactParts.push(`(${contact.relationship})`);
        if (contactParts.length > 0) {
          factsParts.push(`Contact d'urgence: ${contactParts.join(' ')}`);
        }
      }
      
      // Notes (notes ou otherInfo)
      const notes = healthProfile.notes || healthProfile.otherInfo;
      if (notes) {
        if (typeof notes === 'string' && notes.trim()) {
          factsParts.push(`Notes: ${notes.trim()}`);
        } else if (Array.isArray(notes) && notes.length > 0) {
          factsParts.push(`Notes: ${notes.join(' ; ')}`);
        }
      }
      
      // Tous les autres champs du HealthProfile (pour ne rien oublier)
      Object.keys(healthProfile).forEach(key => {
        if (!['allergies', 'chronicConditions', 'chronicDiseases', 'treatments', 'longTermTreatments', 
              'surgeries', 'doctorContacts', 'emergencyContact', 'notes', 'otherInfo', 'updatedAt'].includes(key)) {
          const value = healthProfile[key];
          if (value !== null && value !== undefined && value !== '') {
            if (Array.isArray(value) && value.length > 0) {
              factsParts.push(`${key}: ${value.join(', ')}`);
            } else if (typeof value === 'object' && Object.keys(value).length > 0) {
              factsParts.push(`${key}: ${JSON.stringify(value)}`);
            } else if (typeof value === 'string' && value.trim()) {
              factsParts.push(`${key}: ${value.trim()}`);
            }
          }
        }
      });
    }
    
    // Ajouter les compléments alimentaires
    if (supplements && supplements.length > 0) {
      factsParts.push('\n=== COMPLÉMENTS ALIMENTAIRES ===');
      supplements.forEach(supp => {
        const formatted = formatSupplementForSummary(supp);
        factsParts.push(`- ${formatted}`);
      });
    } else {
      factsParts.push('\n=== COMPLÉMENTS ALIMENTAIRES ===');
      factsParts.push('Aucun');
    }
    
    const factsText = factsParts.join('\n');
    
    // Générer le résumé fallback (toujours disponible) - SANS identité
    const fallbackParts = [];
    
    const medicaments = [];
    ordonnances.forEach(ord => {
      if (Array.isArray(ord.medicaments) && ord.medicaments.length > 0) {
        ord.medicaments.forEach(med => {
          const medName = med.medicament || med.nom || '';
          const dosage = med.dosage || '';
          if (medName) {
            medicaments.push(`${medName}${dosage ? ' ' + dosage : ''}`);
          }
        });
      }
    });
    
    if (medicaments.length > 0) {
      const medCount = medicaments.length;
      fallbackParts.push(`a ${medCount} médicament(s): ${medicaments.join(', ')}`);
    }
    
    const actions = [];
    ordonnances.forEach(ord => {
      if (Array.isArray(ord.actions) && ord.actions.length > 0) {
        ord.actions.forEach(action => {
          let label = action.label || '';
          const ordonnanceIndex = label.indexOf('ORDONNANCE');
          if (ordonnanceIndex !== -1) {
            label = label.substring(ordonnanceIndex + 'ORDONNANCE'.length).trim();
          }
          const scheduledAt = action.scheduledAt;
          const status = scheduledAt ? 'PLANIFIE' : 'A_FAIRE';
          if (label) {
            actions.push(`${label} (${status})`);
          }
        });
      }
    });
    
    if (actions.length > 0) {
      const actionCount = actions.length;
      fallbackParts.push(`${actionCount} action(s): ${actions.join(', ')}`);
    }
    
    if (Array.isArray(personal.allergies) && personal.allergies.length > 0) {
      fallbackParts.push(`Allergies: ${personal.allergies.join(', ')}`);
    }
    
    // Ajouter les compléments dans le fallback
    if (supplements && supplements.length > 0) {
      const suppTexts = supplements.map(supp => formatSupplementForSummary(supp));
      fallbackParts.push(`Compléments alimentaires: ${suppTexts.join(' ; ')}`);
    } else {
      fallbackParts.push('Compléments alimentaires: Aucun');
    }
    
    let fallbackSummary = fallbackParts.join(' ; ');
    if (!fallbackSummary || fallbackSummary.trim().length === 0) {
      fallbackSummary = 'Aucune information médicale disponible.';
    }
    
    // Tenter OpenAI
    let summary = '';
    let source = 'fallback';
    
    const OPENAI_KEY = process.env.OPENAI_API_KEY || req.app.locals?.OPENAI_API_KEY;
    
    if (OPENAI_KEY) {
      try {
        const client = new OpenAI({ apiKey: OPENAI_KEY });
        
        // Construire le prompt système avec instructions strictes
        let systemPrompt = `Tu fais une synthèse factuelle médicale. Aucun diagnostic, aucun conseil médical, aucune interprétation clinique. N'invente rien.

RÈGLES STRICTES:
- Ne JAMAIS inclure de section "Identité", "Patient", "Nom", "Prénom", "Date de naissance" dans le résumé.
- Ne JAMAIS afficher de données nominatives (nom, prénom, âge).
- Structure la réponse en sections recommandées:
  * "Antécédents & allergies"
  * "Traitements en cours"
  * "Compléments alimentaires"
  * "Rendez-vous & examens"
  * "Points d'attention"
- Utilise uniquement les informations présentes dans le contexte fourni.
- Si une information n'est pas dans le contexte, ne l'invente pas.
- Pour la section "Compléments alimentaires", utilise les informations de la section "COMPLÉMENTS ALIMENTAIRES" du contexte. Si cette section indique "Aucun", indique "Aucun complément alimentaire".`;
        
        if (healthProfile) {
          systemPrompt += `\n\nIMPORTANT: La section "CONTEXTE DÉCLARÉ PAR L'UTILISATEUR (HEALTHPROFILE)" contient des informations déclaratives fournies par l'utilisateur. Ce sont des informations déclaratives, ne pas inférer. Utilise-les uniquement si elles sont présentes dans cette section.`;
        }
        
        const completion = await Promise.race([
          client.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0.1,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: factsText }
            ]
          }),
          new Promise((_, reject) => {
            setTimeout(() => {
              reject(new Error('OpenAI API timeout after 60 seconds'));
            }, 60000);
          })
        ]);
        
        // Extraire le texte de manière robuste
        summary = extractTextFromOpenAIResponse(completion);
        
        if (summary && summary.trim().length > 0) {
          source = 'openai';
        }
      } catch (openaiError) {
        console.warn('[AI_SUMMARY_V2] OpenAI error:', openaiError.message);
      }
    }
    
    // Si OpenAI n'a pas fourni de texte, utiliser le fallback
    if (!summary || summary.trim().length === 0) {
      summary = fallbackSummary;
      source = 'fallback';
    }
    
    // Inclure TOUT le healthProfile dans le fallback si présent (SANS identité)
    if (source === 'fallback' && healthProfile) {
      const healthParts = [];
      
      // Allergies
      if (healthProfile.allergies && Array.isArray(healthProfile.allergies) && healthProfile.allergies.length > 0) {
        healthParts.push(`Allergies: ${healthProfile.allergies.join(', ')}`);
      }
      
      // Maladies chroniques (chronicConditions ou chronicDiseases)
      const chronicConditions = healthProfile.chronicConditions || healthProfile.chronicDiseases;
      if (Array.isArray(chronicConditions) && chronicConditions.length > 0) {
        healthParts.push(`Maladies chroniques: ${chronicConditions.join(', ')}`);
      }
      
      // Traitements (treatments ou longTermTreatments)
      const treatments = healthProfile.treatments || healthProfile.longTermTreatments;
      if (Array.isArray(treatments) && treatments.length > 0) {
        const treatmentNames = treatments.map(t => {
          if (typeof t === 'string') return t;
          if (typeof t === 'object' && t.name) return t.name;
          return '';
        }).filter(Boolean);
        if (treatmentNames.length > 0) {
          healthParts.push(`Traitements: ${treatmentNames.join(', ')}`);
        }
      }
      
      // Chirurgies
      if (healthProfile.surgeries && Array.isArray(healthProfile.surgeries) && healthProfile.surgeries.length > 0) {
        const surgeryNames = healthProfile.surgeries.map(s => {
          if (typeof s === 'string') return s;
          if (typeof s === 'object' && s.name) return s.name;
          return '';
        }).filter(Boolean);
        if (surgeryNames.length > 0) {
          healthParts.push(`Chirurgies: ${surgeryNames.join(', ')}`);
        }
      }
      
      if (healthParts.length > 0) {
        summary += (summary ? ' | ' : '') + healthParts.join(' | ');
      }
    }
    
    console.log("[AI_SUMMARY_V2] source=", source, "summaryLength=", summary.length, "healthProfile=", healthProfile ? `hash:${healthProfileHash}` : 'none');

    // Toujours retourner 200 avec summary non vide
    return res.status(200).json({
      ok: true,
      summary: summary,
      source: source,
      serverBuild: "AI_SUMMARY_V2",
      serverTime: new Date().toISOString()
    });

  } catch (error) {
    console.error('[AI_SUMMARY_V2] Erreur:', error.message);
    if (error.stack) {
      console.error('[AI_SUMMARY_V2] Stack:', error.stack);
    }
    
    // Même en cas d'erreur, générer un fallback minimal
    return res.status(200).json({
      ok: true,
      summary: 'Résumé médical non disponible.',
      source: 'fallback',
      serverBuild: "AI_SUMMARY_V2",
      serverTime: new Date().toISOString()
    });
  }
}

console.log('✅ [AI_SUMMARY_V2] handler ready');

app.get('/ai/medical-summary/health', (req, res) => res.status(200).json({ ok: true, path: req.originalUrl }));
app.get('/ai/medical_summary/health', (req, res) => res.status(200).json({ ok: true, path: req.originalUrl }));
app.post('/ai/medical-summary', aiSummaryHandler);
app.post('/ai/medical_summary', aiSummaryHandler);
app.post('/ai/medical-summary-v2', aiSummaryV2Handler);
app.post('/ai/medical_summary_v2', aiSummaryV2Handler);

// ===== AI MEDICAL SUMMARY V2 (avec fallback garanti) =====
/**
 * Construit un texte court pour OpenAI (version simplifiée)
 */
function buildFactsTextShort(personal, ordonnances) {
  const parts = [];
  
  // Nom
  if (personal.nom || personal.prenom) {
    const name = [personal.prenom, personal.nom].filter(Boolean).join(' ').toUpperCase();
    if (name) parts.push(name);
  }
  
  // Allergies
  if (Array.isArray(personal.allergies) && personal.allergies.length > 0) {
    parts.push(`Allergie renseignée : ${personal.allergies.join(', ')}.`);
  }
  
  // Médicaments
  const medicaments = [];
  ordonnances.forEach(ord => {
    if (Array.isArray(ord.medicaments) && ord.medicaments.length > 0) {
      ord.medicaments.forEach(med => {
        const medName = med.medicament || med.nom || '';
        const dosage = med.dosage || '';
        if (medName) {
          medicaments.push(`${medName}${dosage ? ' ' + dosage : ''}`);
        }
      });
    }
  });
  
  if (medicaments.length > 0) {
    parts.push(`Ordonnance de ${medicaments.join(' et ')}.`);
  }
  
  // Actions
  const actions = [];
  ordonnances.forEach(ord => {
    if (Array.isArray(ord.actions) && ord.actions.length > 0) {
      ord.actions.forEach(action => {
        const label = action.label || '';
        const scheduledAt = action.scheduledAt;
        const status = scheduledAt ? 'PLANIFIE' : 'A_FAIRE';
        if (label) {
          actions.push(`${label} (${status})`);
        }
      });
    }
  });
  
  if (actions.length > 0) {
    const actionText = actions.length === 1 
      ? `Une ${actions[0].toLowerCase()} est planifiée.`
      : `Actions : ${actions.join(', ')}.`;
    parts.push(actionText);
  }
  
  return parts.join(' ');
}

/**
 * Génère un résumé fallback déterministe
 */
function generateFallbackSummary(personal, ordonnances) {
  const parts = [];
  
  // Nom
  if (personal.nom || personal.prenom) {
    const name = [personal.prenom, personal.nom].filter(Boolean).join(' ').toUpperCase();
    if (name) parts.push(`${name} a`);
  } else {
    parts.push('Le patient a');
  }
  
  // Médicaments
  const medicaments = [];
  ordonnances.forEach(ord => {
    if (Array.isArray(ord.medicaments) && ord.medicaments.length > 0) {
      ord.medicaments.forEach(med => {
        const medName = med.medicament || med.nom || '';
        const dosage = med.dosage || '';
        if (medName) {
          medicaments.push(`${medName}${dosage ? ' ' + dosage : ''}`);
        }
      });
    }
  });
  
  if (medicaments.length > 0) {
    parts.push(`une ordonnance de ${medicaments.join(' et ')}.`);
  }
  
  // Actions
  const actions = [];
  ordonnances.forEach(ord => {
    if (Array.isArray(ord.actions) && ord.actions.length > 0) {
      ord.actions.forEach(action => {
        const label = action.label || '';
        const scheduledAt = action.scheduledAt;
        if (label) {
          if (scheduledAt) {
            actions.push(`Une imagerie est planifiée (${label.toLowerCase()})`);
          } else {
            actions.push(`Une action est à faire (${label.toLowerCase()})`);
          }
        }
      });
    }
  });
  
  if (actions.length > 0) {
    parts.push(actions.join('. ') + '.');
  }
  
  // Allergies
  if (Array.isArray(personal.allergies) && personal.allergies.length > 0) {
    parts.push(`Allergie renseignée : ${personal.allergies.join(', ')}.`);
  }
  
  return parts.join(' ') || 'Aucune information médicale disponible.';
}

// ===== QR CODE API (Token signé pour ordonnances) =====
// Fonction générique pour créer un token signé
function createSignedToken(payload, secret) {
  // VALIDATION: payload et secret doivent être valides
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload invalide: doit être un objet');
  }
  
  if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
    throw new Error('Secret invalide: doit être une chaîne non vide');
  }
  
  // Encoder le payload en base64url
  let payloadBase64;
  try {
    payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  } catch (error) {
    throw new Error(`Erreur lors de l'encodage du payload: ${error.message}`);
  }
  
  if (!payloadBase64 || payloadBase64.length === 0) {
    throw new Error('Payload encodé est vide');
  }
  
  // Générer la signature HMAC
  const hmac = createHmac('sha256', secret);
  hmac.update(payloadBase64);
  const signature = hmac.digest('base64url');
  
  if (!signature || signature.length === 0) {
    throw new Error('Signature générée est vide');
  }
  
  // Token = payload.signature
  const token = `${payloadBase64}.${signature}`;
  
  // VALIDATION: Le token final ne doit jamais être vide
  if (!token || token.length === 0) {
    throw new Error('Token généré est vide');
  }
  
  return token;
}

// Fonction générique pour vérifier un token signé
function verifySignedToken(token, secret) {
  try {
    // Séparer payload et signature
    const [payloadBase64, signature] = token.split('.');
    if (!payloadBase64 || !signature) {
      return { valid: false, error: 'INVALID_TOKEN_FORMAT' };
    }
    
    // Vérifier la signature
    const hmac = createHmac('sha256', secret);
    hmac.update(payloadBase64);
    const expectedSignature = hmac.digest('base64url');
    
    if (signature !== expectedSignature) {
      return { valid: false, error: 'INVALID_SIGNATURE' };
    }
    
    // Décoder le payload
    const payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8'));
    
    // Vérifier l'expiration
    if (payload.exp && Date.now() > payload.exp) {
      return { valid: false, error: 'TOKEN_EXPIRED' };
    }
    
    return { valid: true, payload };
  } catch (error) {
    return { valid: false, error: 'TOKEN_PARSE_ERROR' };
  }
}

// Génère un token signé pour une ordonnance
function generateQRToken(ordonnanceId) {
  const QR_SECRET = process.env.QR_SECRET || 'default-secret-change-in-production';
  const expiresIn = 7 * 24 * 60 * 60 * 1000; // 7 jours en millisecondes
  const expiresAt = Date.now() + expiresIn;
  
  // Payload: id + exp (pas de données médicales)
  const payload = {
    id: ordonnanceId,
    exp: expiresAt
  };
  
  const token = createSignedToken(payload, QR_SECRET);
  
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

// Vérifie et résout un token QR
function verifyQRToken(token) {
  const QR_SECRET = process.env.QR_SECRET || 'default-secret-change-in-production';
  const result = verifySignedToken(token, QR_SECRET);
  
  if (!result.valid) {
    return result;
  }
  
  return { valid: true, ordonnanceId: result.payload.id };
}

// Route GET /api/ordonnances/:id/qr - Générer un token QR pour une ordonnance
app.get('/api/ordonnances/:id/qr', (req, res) => {
  console.log('[QR] GET /api/ordonnances/:id/qr appelée');
  
  try {
    const ordonnanceId = req.params.id;
    
    if (!ordonnanceId || typeof ordonnanceId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_ORDONNANCE_ID',
        message: 'ID d\'ordonnance invalide'
      });
    }
    
    // Générer le token signé
    const { token, expiresAt } = generateQRToken(ordonnanceId);
    
    // Base URL web (depuis env ou fallback)
    const PUBLIC_WEB_BASE_URL = process.env.PUBLIC_WEB_BASE_URL || 'https://medicalia.app';
    
    // Construire le deep link et l'URL web
    const deepLink = `medicalia://ordonnance/${ordonnanceId}?t=${token}`;
    const webUrl = `${PUBLIC_WEB_BASE_URL}/o/${token}`;
    
    // qrPayload pointe vers webUrl par défaut (scannable universellement)
    const qrPayload = webUrl;
    
    console.log(`[QR] ✅ Token généré pour ordonnance: ${ordonnanceId}`);
    
    return res.status(200).json({
      ok: true,
      ordonnanceId,
      qrPayload,
      qrData: qrPayload, // Alias pour compatibilité frontend
      webUrl,
      deepLink,
      expiresAt
    });
    
  } catch (error) {
    console.error('[QR] ❌ Erreur:', error.message);
    if (error.stack) {
      console.error('[QR] Stack:', error.stack);
    }
    
    return res.status(500).json({
      ok: false,
      error: 'QR_GENERATION_FAILED',
      message: 'Erreur lors de la génération du token QR'
    });
  }
});

// Route GET /api/qr/resolve - Résoudre un token QR
app.get('/api/qr/resolve', (req, res) => {
  console.log('[QR] GET /api/qr/resolve appelée');
  
  try {
    const token = req.query.t;
    
    if (!token || typeof token !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'TOKEN_MISSING',
        message: 'Le paramètre "t" (token) est requis'
      });
    }
    
    // Vérifier le token
    const result = verifyQRToken(token);
    
    if (!result.valid) {
      return res.status(400).json({
        ok: false,
        error: result.error,
        message: `Token invalide: ${result.error}`
      });
    }
    
    console.log(`[QR] ✅ Token résolu: ordonnanceId=${result.ordonnanceId}`);
    
    return res.status(200).json({
      ok: true,
      ordonnanceId: result.ordonnanceId
    });
    
  } catch (error) {
    console.error('[QR] ❌ Erreur:', error.message);
    if (error.stack) {
      console.error('[QR] Stack:', error.stack);
    }
    
    return res.status(500).json({
      ok: false,
      error: 'QR_RESOLVE_FAILED',
      message: 'Erreur lors de la résolution du token QR'
    });
  }
});

// ===== WEB QR PAGES (Mini site pour scans QR universels) =====

// Helper: Détecter le type d'appareil depuis user-agent
function detectDevice(userAgent) {
  if (!userAgent) return 'desktop';
  
  const ua = userAgent.toLowerCase();
  
  if (/iphone|ipad|ipod/.test(ua)) {
    return 'ios';
  }
  
  if (/android/.test(ua)) {
    return 'android';
  }
  
  return 'desktop';
}

// Helper: Générer le lien store selon l'appareil
function getStoreLink(device) {
  // TODO: Remplacer par les vrais liens App Store / Play Store quand disponibles
  const STORE_LINKS = {
    ios: 'https://apps.apple.com/app/medicalia', // TODO: Lien App Store réel
    android: 'https://play.google.com/store/apps/details?id=com.medicalia.app', // TODO: Lien Play Store réel
    desktop: null // Pas de store sur desktop
  };
  
  return STORE_LINKS[device] || null;
}

// Helper: Générer le HTML de la page QR
function generateQRPageHTML(options) {
  const {
    title,
    subtitle,
    icon,
    deepLink,
    storeLink,
    device,
    tokenPrefix
  } = options;
  
  const hasStoreLink = storeLink !== null;
  const storeButtonHTML = hasStoreLink 
    ? `<a href="${storeLink}" class="store-button" target="_blank" rel="noopener noreferrer">Installer l'app</a>`
    : '<p class="info-text">Installez l\'app Medicalia depuis l\'App Store ou Google Play.</p>';
  
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate, proxy-revalidate">
  <meta http-equiv="Pragma" content="no-cache">
  <meta http-equiv="Expires" content="0">
  <title>${title} - Medicalia</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 20px;
      padding: 40px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      text-align: center;
    }
    .logo {
      font-size: 48px;
      margin-bottom: 20px;
    }
    h1 {
      color: #333;
      font-size: 28px;
      margin-bottom: 10px;
      font-weight: 600;
    }
    .subtitle {
      color: #666;
      font-size: 16px;
      margin-bottom: 30px;
      line-height: 1.5;
    }
    .app-button {
      display: inline-block;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 16px 32px;
      border-radius: 12px;
      text-decoration: none;
      font-size: 18px;
      font-weight: 600;
      margin: 10px 0;
      transition: transform 0.2s, box-shadow 0.2s;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
      width: 100%;
      max-width: 280px;
    }
    .app-button:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5);
    }
    .app-button:active {
      transform: translateY(0);
    }
    .store-button {
      display: inline-block;
      background: #f5f5f5;
      color: #333;
      padding: 12px 24px;
      border-radius: 12px;
      text-decoration: none;
      font-size: 16px;
      font-weight: 500;
      margin: 10px 0;
      transition: background 0.2s;
      width: 100%;
      max-width: 280px;
    }
    .store-button:hover {
      background: #e0e0e0;
    }
    .info-text {
      color: #888;
      font-size: 14px;
      margin-top: 20px;
      line-height: 1.6;
    }
    .warning {
      background: #fff3cd;
      border-left: 4px solid #ffc107;
      padding: 12px;
      margin-top: 20px;
      border-radius: 8px;
      font-size: 13px;
      color: #856404;
      text-align: left;
    }
    .warning strong {
      display: block;
      margin-bottom: 4px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">${icon}</div>
    <h1>${title}</h1>
    <p class="subtitle">${subtitle}</p>
    <a href="${deepLink}" class="app-button" id="appButton">Ouvrir dans Medicalia</a>
    ${hasStoreLink ? storeButtonHTML : ''}
    <div class="warning">
      <strong>⚠️ Sécurité</strong>
      Ne donnez pas ce QR code à n'importe qui. Il contient des informations médicales confidentielles.
    </div>
  </div>
  <script>
    // Tentative d'ouverture automatique de l'app (une seule fois, sans boucle)
    (function() {
      var attempted = false;
      var deepLink = "${deepLink}";
      
      // Tentative après 500ms
      setTimeout(function() {
        if (!attempted) {
          attempted = true;
          window.location.href = deepLink;
          
          // Si après 2s on est toujours sur la page, l'app n'est probablement pas installée
          setTimeout(function() {
            // Ne rien faire, laisser l'utilisateur cliquer manuellement
          }, 2000);
        }
      }, 500);
      
      // Fallback: si l'utilisateur clique sur le bouton, on tente à nouveau
      document.getElementById('appButton').addEventListener('click', function(e) {
        if (!attempted) {
          attempted = true;
        }
      });
    })();
  </script>
</body>
</html>`;
}

// Helper: Générer le HTML d'erreur
function generateErrorHTML(message) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate">
  <title>Erreur - Medicalia</title>
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
      text-align: center; 
      padding: 40px 20px; 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 20px;
      max-width: 400px;
    }
    h1 { color: #333; margin-bottom: 10px; }
    p { color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Erreur</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

// Route GET /o/:token - Page web pour QR code ordonnance
app.get('/o/:token', (req, res) => {
  // Log léger: seulement le préfixe du token (premiers 8 caractères)
  const token = req.params.token;
  const tokenPrefix = token && token.length >= 8 ? token.substring(0, 8) + '...' : 'invalid';
  console.log(`[QR_WEB] GET /o/:token appelée (token: ${tokenPrefix})`);
  
  // Headers de sécurité
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  
  try {
    if (!token || typeof token !== 'string' || token.trim() === '') {
      return res.status(400).send(generateErrorHTML('Token invalide'));
    }
    
    // Détecter l'appareil
    const userAgent = req.get('user-agent') || '';
    const device = detectDevice(userAgent);
    const storeLink = getStoreLink(device);
    
    // Deep link: medicalia://o/<token>
    const deepLink = `medicalia://o/${token}`;
    
    // Générer le HTML
    const html = generateQRPageHTML({
      title: 'Ordonnance Medicalia',
      subtitle: 'Accédez à votre ordonnance médicale en toute sécurité',
      icon: '🏥',
      deepLink,
      storeLink,
      device,
      tokenPrefix
    });
    
    res.status(200).send(html);
    
  } catch (error) {
    console.error('[QR_WEB] ❌ Erreur /o/:token:', error.message);
    res.status(500).send(generateErrorHTML('Une erreur est survenue lors du chargement de la page.'));
  }
});

// Route GET /p/:token - Page web pour QR code Passeport Santé
app.get('/p/:token', (req, res) => {
  // Log léger: seulement le préfixe du token (premiers 8 caractères)
  const token = req.params.token;
  const tokenPrefix = token && token.length >= 8 ? token.substring(0, 8) + '...' : 'invalid';
  console.log(`[QR_WEB] GET /p/:token appelée (token: ${tokenPrefix})`);
  
  // Headers de sécurité
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  
  try {
    if (!token || typeof token !== 'string' || token.trim() === '') {
      return res.status(400).send(generateErrorHTML('Token invalide'));
    }
    
    // Détecter l'appareil
    const userAgent = req.get('user-agent') || '';
    const device = detectDevice(userAgent);
    const storeLink = getStoreLink(device);
    
    // Deep link: medicalia://p/<token>
    const deepLink = `medicalia://p/${token}`;
    
    // Générer le HTML
    const html = generateQRPageHTML({
      title: 'Passeport Santé Medicalia',
      subtitle: 'Accédez à votre résumé médical en toute sécurité',
      icon: '📋',
      deepLink,
      storeLink,
      device,
      tokenPrefix
    });
    
    res.status(200).send(html);
    
  } catch (error) {
    console.error('[QR_WEB] ❌ Erreur /p/:token:', error.message);
    res.status(500).send(generateErrorHTML('Une erreur est survenue lors du chargement de la page.'));
  }
});

// Route GET /open/o/:token - Redirection directe vers deep link (sans JS)
// But: Faciliter le bouton "Ouvrir" sans JavaScript
// Comportement:
// - Par défaut: redirige (302) vers medicalia://o/<token>
// - Si ?fallback=1: redirige vers le store (App Store/Play Store) selon l'appareil
// - Si deep link échoue: l'utilisateur reste sur la page d'origine ou est redirigé vers le store
app.get('/open/o/:token', (req, res) => {
  // Log léger: seulement le préfixe du token
  const token = req.params.token;
  const tokenPrefix = token && token.length >= 8 ? token.substring(0, 8) + '...' : 'invalid';
  const fallback = req.query.fallback === '1';
  console.log(`[QR_WEB] GET /open/o/:token appelée (token: ${tokenPrefix}, fallback: ${fallback})`);
  
  try {
    if (!token || typeof token !== 'string' || token.trim() === '') {
      return res.status(400).send(generateErrorHTML('Token invalide'));
    }
    
    // Si fallback=1, rediriger vers le store
    if (fallback) {
      const userAgent = req.get('user-agent') || '';
      const device = detectDevice(userAgent);
      const storeLink = getStoreLink(device);
      
      if (storeLink) {
        return res.redirect(302, storeLink);
      } else {
        // Pas de store disponible (desktop), rediriger vers la page HTML
        return res.redirect(302, `/o/${token}`);
      }
    }
    
    // Par défaut: rediriger vers le deep link
    const deepLink = `medicalia://o/${token}`;
    res.redirect(302, deepLink);
    
  } catch (error) {
    console.error('[QR_WEB] ❌ Erreur /open/o/:token:', error.message);
    // En cas d'erreur, rediriger vers la page HTML
    res.redirect(302, `/o/${token}`);
  }
});

// Route GET /open/p/:token - Redirection directe vers deep link (sans JS)
// But: Faciliter le bouton "Ouvrir" sans JavaScript
// Comportement:
// - Par défaut: redirige (302) vers medicalia://p/<token>
// - Si ?fallback=1: redirige vers le store (App Store/Play Store) selon l'appareil
// - Si deep link échoue: l'utilisateur reste sur la page d'origine ou est redirigé vers le store
app.get('/open/p/:token', (req, res) => {
  // Log léger: seulement le préfixe du token
  const token = req.params.token;
  const tokenPrefix = token && token.length >= 8 ? token.substring(0, 8) + '...' : 'invalid';
  const fallback = req.query.fallback === '1';
  console.log(`[QR_WEB] GET /open/p/:token appelée (token: ${tokenPrefix}, fallback: ${fallback})`);
  
  try {
    if (!token || typeof token !== 'string' || token.trim() === '') {
      return res.status(400).send(generateErrorHTML('Token invalide'));
    }
    
    // Si fallback=1, rediriger vers le store
    if (fallback) {
      const userAgent = req.get('user-agent') || '';
      const device = detectDevice(userAgent);
      const storeLink = getStoreLink(device);
      
      if (storeLink) {
        return res.redirect(302, storeLink);
      } else {
        // Pas de store disponible (desktop), rediriger vers la page HTML
        return res.redirect(302, `/p/${token}`);
      }
    }
    
    // Par défaut: rediriger vers le deep link
    const deepLink = `medicalia://p/${token}`;
    res.redirect(302, deepLink);
    
  } catch (error) {
    console.error('[QR_WEB] ❌ Erreur /open/p/:token:', error.message);
    // En cas d'erreur, rediriger vers la page HTML
    res.redirect(302, `/p/${token}`);
  }
});

// ===== PASSPORT SANTÉ QR API =====
// Stockage temporaire des résumés médicaux (en mémoire, indexé par summaryHash)
const passportSummariesStorage = new Map();

// Fonction pour générer un hash simple d'un résumé
function generateSummaryHash(personal, summary) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ nom: personal.nom, prenom: personal.prenom, summary }));
  return hash.digest('hex').substring(0, 16); // 16 premiers caractères
}

// Handler partagé pour GET et POST /api/passport/qr
// IMPORTANT: Cette fonction garantit qu'on ne renvoie JAMAIS token:null
function handlePassportQR(req, res) {
  console.log(`[PASSPORT_QR] ${req.method} /api/passport/qr appelée`);
  
  try {
    // VALIDATION STRICTE: PASSPORT_QR_SECRET est REQUIS
    // Log DEV: vérifier si le secret est présent
    const hasPassportSecret = !!process.env.PASSPORT_QR_SECRET;
    const hasQrSecret = !!process.env.QR_SECRET;
    
    console.log(`[PASSPORT_QR] DEV: PASSPORT_QR_SECRET présent: ${hasPassportSecret}, QR_SECRET présent: ${hasQrSecret}`);
    
    const PASSPORT_SECRET = process.env.PASSPORT_QR_SECRET || process.env.QR_SECRET;
    
    if (!PASSPORT_SECRET || typeof PASSPORT_SECRET !== 'string' || PASSPORT_SECRET.trim().length === 0) {
      console.error('[PASSPORT_QR] ❌ PASSPORT_SECRET manquant ou invalide');
      console.error('[PASSPORT_QR] ❌ PASSPORT_QR_SECRET:', hasPassportSecret ? 'présent' : 'MANQUANT');
      console.error('[PASSPORT_QR] ❌ QR_SECRET:', hasQrSecret ? 'présent' : 'MANQUANT');
      
      // IMPORTANT: Ne JAMAIS renvoyer token:null, toujours une erreur
      return res.status(500).json({
        ok: false,
        error: 'PASSPORT_SECRET_MISSING',
        message: 'PASSPORT_QR_SECRET ou QR_SECRET est requis pour générer un token valide'
      });
    }
    
    // MVP: accepter patientId ou body minimal (personal.nom + summaryHash)
    const patientId = req.query.patientId || req.body?.patientId;
    const personal = req.body?.personal;
    const summaryHash = req.query.summaryHash || req.body?.summaryHash;
    const healthProfile = req.body?.healthProfile; // Optionnel
    
    // Sécurité: ne pas logger healthProfile en clair
    const healthProfileHash = healthProfile 
      ? createHash('sha256').update(JSON.stringify(healthProfile)).digest('hex').substring(0, 8)
      : null;
    if (healthProfile) {
      console.log(`[PASSPORT_QR] healthProfile reçu (hash: ${healthProfileHash})`);
    }
    
    // Générer un hash si on a personal + summary
    // IMPORTANT: inclure healthProfile dans le hash pour éviter un mauvais cache
    let hash = summaryHash;
    if (!hash && personal && req.body?.summary) {
      // Construire une clé de cache qui inclut healthProfile (via updatedAt ou hash)
      const cacheKeyParts = [
        personal.nom || '',
        personal.prenom || '',
        req.body.summary
      ];
      
      // Ajouter healthProfile dans la clé de cache
      if (healthProfile) {
        // Utiliser updatedAt si présent, sinon hash du contenu
        const profileKey = healthProfile.updatedAt 
          ? healthProfile.updatedAt 
          : createHash('sha256').update(JSON.stringify(healthProfile)).digest('hex').substring(0, 16);
        cacheKeyParts.push(profileKey);
      }
      
      hash = createHash('sha256').update(cacheKeyParts.join('|')).digest('hex').substring(0, 16);
      
      // Construire le résumé enrichi avec healthProfile
      let enrichedSummary = req.body.summary;
      
      // Ajouter healthProfile au résumé si présent
      if (healthProfile) {
        const healthParts = [];
        
        // Allergies
        if (healthProfile.allergies && Array.isArray(healthProfile.allergies) && healthProfile.allergies.length > 0) {
          healthParts.push(`Allergies: ${healthProfile.allergies.join(', ')}`);
        }
        
        // Maladies chroniques
        if (healthProfile.chronicDiseases && Array.isArray(healthProfile.chronicDiseases) && healthProfile.chronicDiseases.length > 0) {
          healthParts.push(`Maladies chroniques: ${healthProfile.chronicDiseases.join(', ')}`);
        }
        
        // Traitements au long cours
        if (healthProfile.longTermTreatments && Array.isArray(healthProfile.longTermTreatments) && healthProfile.longTermTreatments.length > 0) {
          const treatments = healthProfile.longTermTreatments.map(t => {
            if (typeof t === 'string') return t;
            if (typeof t === 'object' && t.name) return t.name + (t.dosage ? ` (${t.dosage})` : '');
            return '';
          }).filter(Boolean);
          if (treatments.length > 0) {
            healthParts.push(`Traitements au long cours: ${treatments.join(', ')}`);
          }
        }
        
        // Contact d'urgence
        if (healthProfile.emergencyContact) {
          const contact = healthProfile.emergencyContact;
          const contactParts = [];
          if (contact.name) contactParts.push(contact.name);
          if (contact.phone) contactParts.push(contact.phone);
          if (contact.relationship) contactParts.push(`(${contact.relationship})`);
          if (contactParts.length > 0) {
            healthParts.push(`Contact d'urgence: ${contactParts.join(' ')}`);
          }
        }
        
        // Ajouter au résumé
        if (healthParts.length > 0) {
          enrichedSummary = enrichedSummary + '\n\n' + healthParts.join('\n');
        }
      }
      
      // Stocker le résumé enrichi pour résolution ultérieure
      passportSummariesStorage.set(hash, {
        summary: enrichedSummary,
        personal,
        healthProfile: healthProfile || null, // Stocker pour référence future
        generatedAt: new Date().toISOString()
      });
    }
    
    const expiresIn = 30 * 24 * 60 * 60 * 1000; // 30 jours en millisecondes
    const expiresAt = Date.now() + expiresIn;
    
    // Payload: type + patientId (optionnel) + summaryHash (optionnel) + exp
    const payload = {
      type: 'passport',
      ...(patientId && { patientId }),
      ...(hash && { summaryHash: hash }),
      exp: expiresAt
    };
    
    // Générer le token signé (version simple qui fonctionnait)
    // IMPORTANT: createSignedToken lance une exception si échec, donc pas besoin de vérifier null
    const token = createSignedToken(payload, PASSPORT_SECRET);
    
    // VALIDATION FINALE: Le token ne doit JAMAIS être null ou vide
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      console.error('[PASSPORT_QR] ❌ Token généré est null ou vide');
      console.error('[PASSPORT_QR] ❌ Payload:', JSON.stringify(payload));
      console.error('[PASSPORT_QR] ❌ Secret présent:', !!PASSPORT_SECRET);
      
      // IMPORTANT: Ne JAMAIS renvoyer token:null, toujours une erreur
      return res.status(500).json({
        ok: false,
        error: 'PASSPORT_TOKEN_GENERATION_FAILED',
        message: 'Le token généré est invalide (null ou vide)'
      });
    }
    
    // Construire le deep link et l'URL web
    const deepLink = `medicalia://passport?t=${token}`;
    const webUrl = `https://medicalia.app/p/${token}`;
    
    // Logs DEV utiles (sans exposer le token complet)
    const tokenPrefix = token.length >= 8 ? token.substring(0, 8) + '...' : 'invalid';
    const payloadKeys = Object.keys(payload).join(',');
    console.log(`[PASSPORT_QR] ✅ Token généré avec succès (prefix: ${tokenPrefix}, expiresAt: ${new Date(expiresAt).toISOString()}, payload keys: ${payloadKeys})`);
    
    // Normaliser la réponse: toujours inclure token (format unique)
    return res.status(200).json({
      ok: true,
      token: token, // TOUJOURS présent, jamais null
      expiresAt: new Date(expiresAt).toISOString(),
      deepLink: deepLink,
      webUrl: webUrl,
      qrPayload: deepLink, // Compatibilité (déprécié, utiliser token)
      serverBuild: 'AI_SUMMARY_V2'
    });
    
  } catch (error) {
    // IMPORTANT: Ne JAMAIS renvoyer token:null, toujours une erreur explicite
    console.error('[PASSPORT_QR] ❌ Erreur critique:', error.message);
    if (error.stack) {
      console.error('[PASSPORT_QR] Stack:', error.stack);
    }
    
    // Logs DEV: détails supplémentaires en développement
    const isDev = process.env.NODE_ENV !== 'production';
    const errorResponse = {
      ok: false,
      error: 'PASSPORT_TOKEN_GENERATION_FAILED',
      message: 'Erreur lors de la génération du token QR Passeport'
    };
    
    if (isDev) {
      errorResponse.details = error.message;
      errorResponse.stack = error.stack;
    }
    
    // IMPORTANT: Ne JAMAIS inclure token:null dans la réponse
    return res.status(500).json(errorResponse);
  }
}

// Route GET /api/passport/qr - Générer un token QR pour le Passeport Santé
app.get('/api/passport/qr', handlePassportQR);

// Route POST /api/passport/qr - Générer un token QR pour le Passeport Santé (alias POST)
// Compatibilité: certaines apps peuvent appeler POST au lieu de GET
app.post('/api/passport/qr', handlePassportQR);

// Route GET /api/passport/resolve - Résoudre un token QR Passeport Santé
app.get('/api/passport/resolve', (req, res) => {
  console.log('[PASSPORT_QR] GET /api/passport/resolve appelée');
  
  try {
    const token = req.query.t;
    
    if (!token || typeof token !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'TOKEN_MISSING',
        message: 'Le paramètre "t" (token) est requis'
      });
    }
    
    // Vérifier si c'est un mode unsigned
    if (token === 'unsigned' || token.includes('mode=unsigned')) {
      return res.status(200).json({
        ok: false,
        error: 'UNSIGNED_QR',
        message: 'QR non signé. Le secret de signature n\'est pas configuré.'
      });
    }
    
    // Récupérer le secret
    const PASSPORT_SECRET = process.env.PASSPORT_QR_SECRET || process.env.QR_SECRET;
    
    if (!PASSPORT_SECRET) {
      return res.status(200).json({
        ok: false,
        error: 'PASSPORT_SECRET_MISSING',
        message: 'QR non signé. Le secret de signature n\'est pas configuré.'
      });
    }
    
    // Vérifier le token
    const result = verifySignedToken(token, PASSPORT_SECRET);
    
    if (!result.valid) {
      console.log(`[PASSPORT_QR] resolve fail: ${result.error}`);
      return res.status(400).json({
        ok: false,
        error: result.error,
        message: `Token invalide: ${result.error}`
      });
    }
    
    const payload = result.payload;
    
    // Vérifier que c'est un token passport
    if (payload.type !== 'passport') {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_TOKEN_TYPE',
        message: 'Token non valide pour Passeport Santé'
      });
    }
    
    // MVP: Récupérer le résumé depuis le stockage ou générer un message
    let summary = 'Résumé indisponible';
    let source = 'generated';
    let generatedAt = new Date().toISOString();
    
    if (payload.summaryHash) {
      const stored = passportSummariesStorage.get(payload.summaryHash);
      if (stored) {
        summary = stored.summary;
        source = 'cache';
        generatedAt = stored.generatedAt;
      }
    }
    
    console.log(`[PASSPORT_QR] resolve ok: type=${payload.type}, source=${source}`);
    
    return res.status(200).json({
      ok: true,
      type: 'passport',
      summary,
      source,
      generatedAt
    });
    
  } catch (error) {
    console.error('[PASSPORT_QR] ❌ Erreur:', error.message);
    if (error.stack) {
      console.error('[PASSPORT_QR] Stack:', error.stack);
    }
    
    return res.status(500).json({
      ok: false,
      error: 'PASSPORT_RESOLVE_FAILED',
      message: 'Erreur lors de la résolution du token QR Passeport'
    });
  }
});

// ===== DELIVERY ORDERS API =====
// Stockage temporaire des commandes de livraison (en mémoire)
// TODO: Migrer vers une base de données persistante (PostgreSQL/MongoDB)
const deliveryOrdersStorage = new Map();

// Statuts valides pour une commande de livraison
const VALID_DELIVERY_STATUSES = ['PENDING', 'ACCEPTED', 'PICKED_UP'];

// Validation du body pour créer une commande de livraison
function validateCreateDeliveryOrderBody(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'BODY_MISSING', message: 'Le body de la requête est manquant' };
  }
  
  if (!body.ordonnanceId || typeof body.ordonnanceId !== 'string' || body.ordonnanceId.trim() === '') {
    return { valid: false, error: 'ORDONNANCE_ID_MISSING', message: 'ordonnanceId est requis et doit être une chaîne non vide' };
  }
  
  if (!body.pharmacyId || typeof body.pharmacyId !== 'string' || body.pharmacyId.trim() === '') {
    return { valid: false, error: 'PHARMACY_ID_MISSING', message: 'pharmacyId est requis et doit être une chaîne non vide' };
  }
  
  if (!body.deliveryAddress || typeof body.deliveryAddress !== 'string' || body.deliveryAddress.trim() === '') {
    return { valid: false, error: 'DELIVERY_ADDRESS_MISSING', message: 'deliveryAddress est requis et doit être une chaîne non vide' };
  }
  
  // Champs optionnels
  if (body.deliveryNote !== undefined && typeof body.deliveryNote !== 'string') {
    return { valid: false, error: 'INVALID_DELIVERY_NOTE', message: 'deliveryNote doit être une chaîne ou null' };
  }
  
  if (body.patientPhone !== undefined && typeof body.patientPhone !== 'string') {
    return { valid: false, error: 'INVALID_PATIENT_PHONE', message: 'patientPhone doit être une chaîne ou null' };
  }
  
  if (body.timeWindow !== undefined && typeof body.timeWindow !== 'string') {
    return { valid: false, error: 'INVALID_TIME_WINDOW', message: 'timeWindow doit être une chaîne ou null' };
  }
  
  return { valid: true };
}

// Validation du body pour mettre à jour le statut
function validateUpdateStatusBody(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'BODY_MISSING', message: 'Le body de la requête est manquant' };
  }
  
  if (!body.status || typeof body.status !== 'string') {
    return { valid: false, error: 'STATUS_MISSING', message: 'status est requis et doit être une chaîne' };
  }
  
  if (!VALID_DELIVERY_STATUSES.includes(body.status)) {
    return { 
      valid: false, 
      error: 'INVALID_STATUS', 
      message: `status doit être l'un des suivants: ${VALID_DELIVERY_STATUSES.join(', ')}` 
    };
  }
  
  return { valid: true };
}

// Fonction pour créer un objet DeliveryOrder
function createDeliveryOrder(data) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +24h
  
  return {
    id: randomUUID(),
    ordonnanceId: data.ordonnanceId,
    pharmacyId: data.pharmacyId,
    status: 'PENDING',
    deliveryAddress: data.deliveryAddress,
    deliveryNote: data.deliveryNote || null,
    patientPhone: data.patientPhone || null,
    timeWindow: data.timeWindow || null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
}

// Fonction pour nettoyer les données sensibles avant de renvoyer une commande
// SÉCURITÉ: Ne jamais exposer le contenu de l'ordonnance ni le QR
function sanitizeDeliveryOrder(order) {
  if (!order) return null;
  
  return {
    id: order.id,
    ordonnanceId: order.ordonnanceId,
    pharmacyId: order.pharmacyId,
    status: order.status,
    deliveryAddress: order.deliveryAddress,
    deliveryNote: order.deliveryNote,
    patientPhone: order.patientPhone,
    timeWindow: order.timeWindow,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    expiresAt: order.expiresAt
    // NOTE: Pas de contenu ordonnance, pas de QR, pas de données médicales
  };
}

// Placeholder pour notifier la pharmacie
function notifyPharmacy(order) {
  console.log('[DELIVERY] 📧 Notifier pharmacie:', {
    orderId: order.id,
    pharmacyId: order.pharmacyId,
    status: order.status,
    // TODO: Implémenter notification Twilio/FCM/SMS
  });
}

// Placeholder pour notifier le pool de livreurs
function notifyCourierPool(order) {
  console.log('[DELIVERY] 🚚 Notifier pool de livreurs:', {
    orderId: order.id,
    pharmacyId: order.pharmacyId,
    deliveryAddress: order.deliveryAddress,
    status: order.status,
    // TODO: Implémenter notification FCM/Push pour livreurs
  });
}

// Route POST /delivery/orders - Créer une commande de livraison
app.post('/delivery/orders', (req, res) => {
  console.log('[DELIVERY] POST /delivery/orders appelée');
  
  try {
    // Validation
    const validation = validateCreateDeliveryOrderBody(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        ok: false,
        error: validation.error,
        message: validation.message
      });
    }

    // Créer la commande
    const order = createDeliveryOrder({
      ordonnanceId: req.body.ordonnanceId.trim(),
      pharmacyId: req.body.pharmacyId.trim(),
      deliveryAddress: req.body.deliveryAddress.trim(),
      deliveryNote: req.body.deliveryNote?.trim() || null,
      patientPhone: req.body.patientPhone?.trim() || null,
      timeWindow: req.body.timeWindow?.trim() || null
    });

    // Stocker en mémoire
    deliveryOrdersStorage.set(order.id, order);
    
    console.log(`[DELIVERY] ✅ Commande créée: ${order.id} (total: ${deliveryOrdersStorage.size})`);

    // Notifier la pharmacie (placeholder)
    notifyPharmacy(order);

    // Retourner la réponse (sans données sensibles)
    return res.status(200).json({
      ok: true,
      order: sanitizeDeliveryOrder(order)
    });

  } catch (error) {
    console.error('[DELIVERY] ❌ Erreur:', error.message);
    if (error.stack) {
      console.error('[DELIVERY] Stack:', error.stack);
    }
    
    return res.status(500).json({
      ok: false,
      error: 'DELIVERY_ORDER_CREATION_FAILED',
      message: 'Erreur lors de la création de la commande de livraison'
    });
  }
});

// Route GET /delivery/orders/:id - Lire une commande
app.get('/delivery/orders/:id', (req, res) => {
  console.log('[DELIVERY] GET /delivery/orders/:id appelée');
  
  try {
    const orderId = req.params.id;
    
    if (!orderId || typeof orderId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_ORDER_ID',
        message: 'ID de commande invalide'
      });
    }

    const order = deliveryOrdersStorage.get(orderId);
    
    if (!order) {
      return res.status(404).json({
        ok: false,
        error: 'ORDER_NOT_FOUND',
        message: 'Commande non trouvée'
      });
    }

    // Retourner la commande (sans données sensibles)
    return res.status(200).json({
      ok: true,
      order: sanitizeDeliveryOrder(order)
    });

  } catch (error) {
    console.error('[DELIVERY] ❌ Erreur:', error.message);
    if (error.stack) {
      console.error('[DELIVERY] Stack:', error.stack);
    }
    
    return res.status(500).json({
      ok: false,
      error: 'DELIVERY_ORDER_FETCH_FAILED',
      message: 'Erreur lors de la récupération de la commande'
    });
  }
});

// Route GET /delivery/orders?ordonnanceId=... - Lister les commandes d'une ordonnance
app.get('/delivery/orders', (req, res) => {
  console.log('[DELIVERY] GET /delivery/orders appelée');
  
  try {
    const ordonnanceId = req.query.ordonnanceId;
    
    if (!ordonnanceId || typeof ordonnanceId !== 'string' || ordonnanceId.trim() === '') {
      return res.status(400).json({
        ok: false,
        error: 'ORDONNANCE_ID_MISSING',
        message: 'Le paramètre ordonnanceId est requis'
      });
    }

    // Filtrer les commandes par ordonnanceId
    const orders = Array.from(deliveryOrdersStorage.values())
      .filter(order => order.ordonnanceId === ordonnanceId.trim())
      .map(order => sanitizeDeliveryOrder(order));

    return res.status(200).json({
      ok: true,
      orders,
      count: orders.length
    });

  } catch (error) {
    console.error('[DELIVERY] ❌ Erreur:', error.message);
    if (error.stack) {
      console.error('[DELIVERY] Stack:', error.stack);
    }
    
    return res.status(500).json({
      ok: false,
      error: 'DELIVERY_ORDERS_FETCH_FAILED',
      message: 'Erreur lors de la récupération des commandes'
    });
  }
});

// Route PATCH /delivery/orders/:id/status - Mettre à jour le statut (pour tests/admin)
app.patch('/delivery/orders/:id/status', (req, res) => {
  console.log('[DELIVERY] PATCH /delivery/orders/:id/status appelée');
  
  try {
    const orderId = req.params.id;
    
    if (!orderId || typeof orderId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_ORDER_ID',
        message: 'ID de commande invalide'
      });
    }

    // Validation du body
    const validation = validateUpdateStatusBody(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        ok: false,
        error: validation.error,
        message: validation.message
      });
    }

    const order = deliveryOrdersStorage.get(orderId);
    
    if (!order) {
      return res.status(404).json({
        ok: false,
        error: 'ORDER_NOT_FOUND',
        message: 'Commande non trouvée'
      });
    }

    // Mettre à jour le statut
    const oldStatus = order.status;
    order.status = req.body.status;
    order.updatedAt = new Date().toISOString();
    
    // Mettre à jour le stockage
    deliveryOrdersStorage.set(orderId, order);
    
    console.log(`[DELIVERY] ✅ Statut mis à jour: ${orderId} ${oldStatus} → ${order.status}`);

    // Notifier selon le nouveau statut
    if (order.status === 'ACCEPTED') {
      notifyCourierPool(order);
    }

    // Retourner la commande mise à jour (sans données sensibles)
    return res.status(200).json({
      ok: true,
      order: sanitizeDeliveryOrder(order)
    });

  } catch (error) {
    console.error('[DELIVERY] ❌ Erreur:', error.message);
    if (error.stack) {
      console.error('[DELIVERY] Stack:', error.stack);
    }
    
    return res.status(500).json({
      ok: false,
      error: 'DELIVERY_ORDER_UPDATE_FAILED',
      message: 'Erreur lors de la mise à jour du statut de la commande'
    });
  }
});

// Handler 404 pour les routes non trouvées (catch-all)
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.originalUrl}`);
  
  // Liste des routes disponibles
  const availableRoutes = [
      'GET /health',
      'GET /ping',
    'GET /version',
    'GET /beacon',
    'GET /healthz',
    'GET /billing/plan',
    'POST /push/register-token',
      'POST /extract',
    'GET /ai/medical-summary/health',
    'GET /ai/medical_summary/health',
    'POST /ai/medical-summary',
    'POST /ai/medical_summary',
    'POST /ai/medical-summary-v2',
    'POST /ai/medical_summary_v2',
    'POST /ordonnances/:id/recovered',
    'POST /devices/heartbeat',
    'GET /treatments/active',
    'POST /care/invite',
    'POST /care/accept',
    'POST /care/revoke',
      'POST /analyze-ordonnance',
      'POST /analyze-ordonnance-test',
      'GET /test-n8n',
      'POST /api/ocr/handwritten',
      'POST /api/ordonnances/create',
      'POST /api/ordonnance/ocr',
      'POST /api/ordonnance/analyze',
      'POST /api/ordonnance/photo',
      'POST /api/ordonnance/finalize',
      'POST /ocr-photo',
      'GET /api/ordonnances',
      'GET /api/ordonnances/:id/qr',
      'GET /api/qr/resolve',
      'GET /o/:token',
      'GET /p/:token',
      'GET /open/o/:token',
      'GET /open/p/:token',
      'GET /api/passport/qr',
      'GET /api/passport/resolve',
      'POST /delivery/orders',
      'GET /delivery/orders/:id',
      'GET /delivery/orders?ordonnanceId=...',
      'PATCH /delivery/orders/:id/status'
  ];
  
  res.status(404).json({ 
    error: 'ROUTE_NOT_FOUND',
    path: req.originalUrl,
    availableRoutes: availableRoutes
  });
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`✅ Serveur démarré sur http://localhost:${PORT}`);
  console.log(`[APP] Base URL: ${APP_CONFIG.baseUrl}`);
  
  // Lister les routes montées
  try {
    logRegisteredRoutes();
  } catch (err) {
    console.warn('⚠️ Impossible de lister les routes:', err.message);
  }
});
