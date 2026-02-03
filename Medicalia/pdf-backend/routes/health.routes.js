import { Router } from 'express';

const router = Router();

// GET /
router.get('/', (req, res) => {
  res.send('BACKEND OK');
});

// GET /favicon.ico
router.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// GET /ping
router.get('/ping', (req, res) => {
  console.log('PING OK');
  res.status(200).json({ status: 'OK' });
});

// GET /healthz
router.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, boot: 'AI_SUMMARY_PATCH_V1' });
});

// GET /__build
router.get('/__build', (req, res) => {
  res.json({ ok: true, build: '__BUILD_CHECK' });
});

// GET /health
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: Date.now(),
    serverBuild: 'AI_SUMMARY_V2_INLINE',
  });
});

// GET /version
router.get('/version', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'pdf-backend',
    serverBuild: 'AI_SUMMARY_V2_INLINE',
    timestamp: Date.now(),
    passportSecretLoaded: Boolean(process.env.PASSPORT_QR_SECRET),
    qrSecretLoaded: Boolean(process.env.QR_SECRET),
  });
});

// GET /beacon
router.get('/beacon', (req, res) => {
  res.status(204).end();
});

export default router;
