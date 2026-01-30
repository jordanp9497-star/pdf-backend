/**
 * Routes de debug (DEV uniquement)
 * 
 * Endpoints pour vérifier la configuration sans exposer de secrets
 */

import express from 'express';
import { APP_CONFIG, SUPABASE_CONFIG, STRIPE_CONFIG } from '../src/config/env.js';

const router = express.Router();

/**
 * GET /debug/env
 * 
 * Retourne le statut des variables d'environnement (sans exposer les secrets)
 * Uniquement disponible en développement
 */
router.get('/env', (req, res) => {
  // Vérifier que nous ne sommes pas en production
  if (APP_CONFIG.nodeEnv === 'production') {
    return res.status(403).json({
      ok: false,
      error: 'FORBIDDEN',
      message: 'Cet endpoint n\'est pas disponible en production'
    });
  }

  return res.status(200).json({
    ok: true,
    env: {
      nodeEnv: APP_CONFIG.nodeEnv,
      supabaseUrlPresent: !!SUPABASE_CONFIG.url,
      supabaseServiceRoleKeyPresent: !!SUPABASE_CONFIG.serviceRoleKey,
      supabaseJwtJwksUrl: SUPABASE_CONFIG.jwtJwksUrl,
      stripeSecretKeyPresent: !!STRIPE_CONFIG.secretKey,
      stripeWebhookSecretPresent: !!STRIPE_CONFIG.webhookSecret,
      stripePriceIdPresent: !!STRIPE_CONFIG.priceId,
      appBaseUrl: APP_CONFIG.baseUrl,
      port: APP_CONFIG.port,
    }
  });
});

export default router;
