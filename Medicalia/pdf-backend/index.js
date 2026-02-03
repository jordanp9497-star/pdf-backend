// ===== CONFIGURATION CENTRALISÉE =====
import { logEnvStatus, APP_CONFIG } from './src/config/env.js';

console.log("✅ BOOT SIGNATURE __BUILD_CHECK");
console.log("🚀 Backend started");

// Crash au démarrage si Supabase manquant
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Démarrage impossible: SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis.'
  );
}

// ===== HANDLERS GLOBAUX ANTI-CRASH =====
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT_EXCEPTION]', err?.message ?? err);
  console.error('[UNCAUGHT_EXCEPTION] stack:', err?.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED_REJECTION] reason:', reason);
  console.error('[UNHANDLED_REJECTION] promise:', promise);
});

logEnvStatus();

// OpenAI désactivé: ne jamais exiger OPENAI_API_KEY au démarrage.

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { ensureBucketExists } from './src/services/storageService.js';

const app = express();
const PORT = APP_CONFIG.port;

// ===== WEBHOOK STRIPE (AVANT LES BODY PARSERS) =====
import { handleStripeWebhook } from './routes/billing.routes.js';
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

// ===== BODY PARSERS =====
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

  const originalSend = res.send;
  const originalJson = res.json;

  res.send = function (body) {
    const duration = Date.now() - startTime;
    console.log(`[${method}] ${path} - ${res.statusCode} - ${duration}ms - ${contentType} - ${userAgent} - ${ip}`);
    return originalSend.call(this, body);
  };

  res.json = function (body) {
    const duration = Date.now() - startTime;
    console.log(`[${method}] ${path} - ${res.statusCode} - ${duration}ms - ${contentType} - ${userAgent} - ${ip}`);
    return originalJson.call(this, body);
  };

  next();
});

// ===== CORS =====
app.use(cors());

// ===== HELMET (Sécurité HTTP) =====
app.use(helmet());

// ===== RATE LIMITING =====
// Global : 100 req/min par IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMIT_EXCEEDED', message: 'Trop de requêtes, réessayez dans 1 minute' },
});
app.use(globalLimiter);

// OCR : 5 req/min (endpoint gourmand)
const ocrLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'OCR_RATE_LIMIT', message: 'Limite OCR atteinte, réessayez dans 1 minute' },
});
app.use('/api/ocr', ocrLimiter);
app.use('/ocr-photo', ocrLimiter);
app.use('/api/ordonnance/ocr', ocrLimiter);
app.use('/api/ordonnance/photo', ocrLimiter);

// Auth : 10 req/min (anti brute-force)
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AUTH_RATE_LIMIT', message: 'Trop de tentatives, réessayez dans 1 minute' },
});
app.use('/api/billing/webhook', authLimiter);

// ===== STOCKAGE CLÉ OPENAI DANS app.locals =====
app.locals.OPENAI_API_KEY = null;

// ===== MIDDLEWARES D'AUTHENTIFICATION =====
import { authenticateSupabase } from './middlewares/auth.js';
import { requireProfileRole } from './middlewares/profileRole.js';
app.locals.authenticateSupabase = authenticateSupabase;
app.locals.requireProfileRole = requireProfileRole;

// ===== MONTAGE DES ROUTES =====
import healthRouter from './routes/health.routes.js';
import ocrRouter from './routes/ocr.routes.js';
import ordonnanceAnalysisRouter from './routes/ordonnanceAnalysis.routes.js';
import aiSummaryInlineRouter from './routes/aiSummaryInline.routes.js';
import qrRouter from './routes/qr.routes.js';
import passportRouter from './routes/passport.routes.js';
import deliveryRouter from './routes/delivery.routes.js';
import pushRouter from './routes/push.routes.js';
import aiSummaryRouter from './routes/aiSummary.routes.js';
import medsRouter from './routes/meds.routes.js';
import billingRouter from './routes/billing.routes.js';
import debugRouter from './routes/debug.routes.js';
import ordonnancesRouter from './routes/ordonnances.routes.js';
import prescriptionsRouter from './src/routes/prescriptions.js';
import childrenRouter from './routes/children.routes.js';
import appointmentsRouter from './routes/appointments.routes.js';
import devicesRouter from './routes/devices.routes.js';
import treatmentsRouter from './routes/treatments.routes.js';
import supplementsRouter from './routes/supplements.routes.js';
import careRouter from './routes/care.routes.js';
import invitesRouter from './routes/invites.routes.js';

// Health & infra (pas de préfixe /api pour health checks)
app.use('/', healthRouter);

// OCR & ordonnance processing (routes internes déjà préfixées /api/ dans le router)
app.use('/', ocrRouter);
app.use('/', ordonnanceAnalysisRouter);

// AI Summary
app.use('/api/ai', aiSummaryInlineRouter);
app.use('/api/ai', aiSummaryRouter);

// QR codes & passport santé
app.use('/api', qrRouter);
app.use('/api', passportRouter);

// Delivery & push
app.use('/api/delivery', deliveryRouter);
app.use('/api/push', pushRouter);

// Business routes
app.use('/api/billing', billingRouter);
app.use('/api/meds', medsRouter);
app.use('/api/ordonnances', ordonnancesRouter);
app.use('/api/prescriptions', prescriptionsRouter);
app.use('/api/children', childrenRouter);
app.use('/api/appointments', appointmentsRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/treatments', treatmentsRouter);
app.use('/api/supplements', supplementsRouter);
app.use('/api/care', careRouter);
app.use('/api/debug', debugRouter);
app.use('/api', invitesRouter);

// ===== LEGACY REDIRECTS (301) - Anciens chemins sans /api/ =====
// À supprimer après 1 sprint
const legacyPrefixes = ['/ai', '/delivery', '/push', '/billing', '/meds', '/ordonnances', '/devices', '/treatments', '/supplements', '/care', '/debug'];
for (const prefix of legacyPrefixes) {
  app.use(prefix, (req, res) => {
    const newUrl = `/api${prefix}${req.url}`;
    console.log(`[LEGACY 301] ${req.method} ${req.originalUrl} -> ${newUrl}`);
    res.redirect(301, newUrl);
  });
}

// ===== 404 HANDLER =====
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    error: 'ROUTE_NOT_FOUND',
    path: req.originalUrl,
  });
});

// ===== DÉMARRAGE =====
ensureBucketExists('prescriptions')
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Serveur démarré sur http://localhost:${PORT}`);
      console.log(`[APP] Base URL: ${APP_CONFIG.baseUrl}`);
    });
  })
  .catch((err) => {
    console.error('[BOOT] Bucket Storage "prescriptions" introuvable:', err?.message ?? err);
    process.exit(1);
  });
