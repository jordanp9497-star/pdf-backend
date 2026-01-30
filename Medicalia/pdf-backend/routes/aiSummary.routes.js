import express from 'express';

const router = express.Router();

/**
 * Handler pour GET /ai/medical-summary/health (dash)
 */
router.get('/medical-summary/health', (req, res) => {
  console.log(`[AI_SUMMARY] GET /medical-summary/health - ${req.originalUrl}`);
  return res.status(200).json({
    ok: true,
    variant: 'dash',
    path: req.originalUrl
  });
});

/**
 * Handler pour GET /ai/medical_summary/health (underscore)
 */
router.get('/medical_summary/health', (req, res) => {
  console.log(`[AI_SUMMARY] GET /medical_summary/health - ${req.originalUrl}`);
  return res.status(200).json({
    ok: true,
    variant: 'underscore',
    path: req.originalUrl
  });
});

/**
 * Handler unique pour POST /ai/medical-summary et /ai/medical_summary
 */
function handlePost(req, res) {
  console.log(`[AI_SUMMARY] POST ${req.path} - ${req.originalUrl}`);
  
  // Vérification du body
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_BODY',
      message: 'Body doit être un objet JSON'
    });
  }

  // Vérification de personal
  if (!req.body.personal || typeof req.body.personal !== 'object') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_BODY',
      message: 'Le champ "personal" (objet) est requis'
    });
  }

  // Vérification de ordonnances
  if (!Array.isArray(req.body.ordonnances)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_BODY',
      message: 'Le champ "ordonnances" (tableau) est requis'
    });
  }

  // Réponse mock
  return res.status(200).json({
    ok: true,
    path: req.originalUrl,
    received: {
      personalKeys: Object.keys(req.body.personal || {}),
      ordonnancesCount: Array.isArray(req.body.ordonnances) ? req.body.ordonnances.length : 0
    }
  });
}

// Routes POST avec dash
router.post('/medical-summary', handlePost);

// Routes POST avec underscore
router.post('/medical_summary', handlePost);

export default router;
