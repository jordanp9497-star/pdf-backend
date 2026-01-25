/**
 * Helper pour récupérer les limites du plan utilisateur
 * 
 * Vérifie si l'utilisateur est pro via:
 * - subscriptions.status = 'active' (priorité)
 * - profiles.is_pro = true (fallback)
 */

import { supabaseAdmin } from './supabaseAdmin.js';

const supabase = supabaseAdmin;

/**
 * Récupère les limites du plan pour un utilisateur
 * 
 * @param {string} userId - ID de l'utilisateur
 * @returns {Promise<{ isPro: boolean, maxDevices: number }>}
 */
export async function getPlanLimits(userId) {
  if (!supabase || !userId) {
    // Par défaut: plan gratuit
    return {
      isPro: false,
      maxDevices: 2
    };
  }

  try {
    // 1. Vérifier d'abord dans subscriptions (priorité)
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .select('status, current_period_end')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle();

    if (!subError && subscription) {
      // Vérifier que l'abonnement n'est pas expiré
      const now = new Date();
      const periodEnd = new Date(subscription.current_period_end);

      if (periodEnd > now) {
        // Utilisateur avec abonnement actif = Pro
        return {
          isPro: true,
          maxDevices: 10 // Limite Pro
        };
      }
    }

    // 2. Fallback: vérifier profiles.is_pro
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('is_pro')
      .eq('id', userId)
      .maybeSingle();

    if (!profileError && profile && profile.is_pro === true) {
      return {
        isPro: true,
        maxDevices: 10 // Limite Pro
      };
    }

    // 3. Par défaut: plan gratuit
    return {
      isPro: false,
      maxDevices: 2 // Limite gratuit
    };

  } catch (error) {
    console.error('[PLAN_LIMITS] Erreur lors de la récupération des limites:', error);
    // En cas d'erreur, retourner les limites gratuites (sécurisé)
    return {
      isPro: false,
      maxDevices: 2
    };
  }
}
