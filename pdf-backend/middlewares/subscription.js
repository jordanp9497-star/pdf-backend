/**
 * Middleware pour vérifier qu'un utilisateur a un abonnement actif
 * 
 * Utilise la fonction isSubscribed pour vérifier l'abonnement
 * Retourne 403 si l'utilisateur n'est pas abonné
 */

import { isSubscribed } from '../routes/billing.routes.js';

/**
 * Middleware pour exiger un abonnement actif
 * 
 * Usage:
 *   router.post('/premium-feature',
 *     authenticateSupabase,
 *     requireSubscription,
 *     handler
 *   );
 */
export const requireSubscription = async (req, res, next) => {
  try {
    // Vérifier que l'utilisateur est authentifié
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise'
      });
    }

    // Vérifier l'abonnement
    const subscribed = await isSubscribed(req.user.id);

    if (!subscribed) {
      console.log(`[SUBSCRIPTION] ❌ Utilisateur ${req.user.id} n'a pas d'abonnement actif`);
      return res.status(403).json({
        ok: false,
        error: 'SUBSCRIPTION_REQUIRED',
        message: 'Un abonnement actif est requis pour accéder à cette fonctionnalité'
      });
    }

    console.log(`[SUBSCRIPTION] ✅ Utilisateur ${req.user.id} a un abonnement actif`);
    next();

  } catch (error) {
    console.error('[SUBSCRIPTION] ❌ Erreur lors de la vérification de l\'abonnement:', error);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Erreur lors de la vérification de l\'abonnement'
    });
  }
};
