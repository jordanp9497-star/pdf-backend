/**
 * Middleware pour vérifier les entitlements (limites du plan)
 * 
 * Vérifie le nombre d'appareils actifs et compare avec les limites du plan
 * Utilise getPlanLimits() pour déterminer les limites
 */

import { supabaseAdmin } from '../src/lib/supabaseAdmin.js';
import { getPlanLimits } from '../src/lib/planLimits.js';

const supabase = supabaseAdmin;

/**
 * Middleware pour vérifier que l'utilisateur n'a pas dépassé la limite d'appareils
 * 
 * @param {string} entitlementType - Type d'entitlement à vérifier (ex: 'devices')
 * @returns {Function} Middleware Express
 */
export function requireEntitlement(entitlementType = 'devices') {
  return async (req, res, next) => {
    try {
      const userId = req.userId || req.user?.id;
      
      if (!userId) {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'Authentification requise'
        });
      }

      if (!supabase) {
        console.error('[ENTITLEMENT] ❌ Supabase admin client non initialisé');
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la vérification des limites'
        });
      }

      // Récupérer les limites du plan
      const limits = await getPlanLimits(userId);

      // Vérifier selon le type d'entitlement
      if (entitlementType === 'devices') {
        // Compter les appareils actifs (last_seen_at < 7 jours)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const { count, error: countError } = await supabase
          .from('devices')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId)
          .gte('last_seen_at', sevenDaysAgo.toISOString());

        if (countError) {
          console.error('[ENTITLEMENT] Error counting devices:', countError);
          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la vérification des limites'
          });
        }

        const deviceCount = count || 0;

        // Vérifier si la limite est dépassée
        if (deviceCount >= limits.maxDevices) {
          console.log(`[ENTITLEMENT] ❌ Limite d'appareils dépassée pour userId ${userId}`, {
            deviceCount,
            maxDevices: limits.maxDevices,
            isPro: limits.isPro
          });

          return res.status(402).json({
            ok: false,
            error: 'PAYMENT_REQUIRED',
            message: `Trop d'appareils actifs (${deviceCount}/${limits.maxDevices}). Passez au plan supérieur pour augmenter la limite.`,
            limit: limits.maxDevices,
            current: deviceCount
          });
        }

        console.log(`[ENTITLEMENT] ✅ Limite d'appareils OK pour userId ${userId}`, {
          deviceCount,
          maxDevices: limits.maxDevices,
          isPro: limits.isPro
        });
      }

      // Si tout est OK, continuer
      next();

    } catch (error) {
      console.error('[ENTITLEMENT] ❌ Erreur lors de la vérification des entitlements:', error);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de la vérification des limites'
      });
    }
  };
}
