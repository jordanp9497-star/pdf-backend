import express from 'express';

const router = express.Router();

/**
 * Handler unique pour POST /ai/medical-summary
 * Valide le body et retourne une réponse mock
 */
function handleMedicalSummary(req, res) {
  console.log(`[AI_SUMMARY] ${req.method} ${req.path} - ${req.originalUrl}`);
  
  // Validation
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({
      error: 'INVALID_BODY',
      message: 'Body doit être un objet JSON'
    });
  }

  if (!req.body.personal || typeof req.body.personal !== 'object') {
    return res.status(400).json({
      error: 'INVALID_BODY',
      message: 'Le champ "personal" (objet) est requis'
    });
  }

  if (!Array.isArray(req.body.ordonnances)) {
    return res.status(400).json({
      error: 'INVALID_BODY',
      message: 'Le champ "ordonnances" (tableau) est requis'
    });
  }

  // Réponse mock
  return res.status(200).json({
    ok: true,
    received: {
      personalKeys: Object.keys(req.body.personal || {}),
      ordonnancesCount: req.body.ordonnances.length
    },
    routeHit: req.originalUrl
  });
}

/**
 * Handler pour GET /ai/medical-summary/health
 */
function handleHealth(req, res) {
  console.log(`[AI_SUMMARY] ${req.method} ${req.path} - ${req.originalUrl}`);
  return res.status(200).json({
    ok: true,
    routeHit: req.originalUrl
  });
}

// Routes POST /ai/medical-summary
router.post('/medical-summary', handleMedicalSummary);

// Routes GET /ai/medical-summary/health
router.get('/medical-summary/health', handleHealth);

export default router;
