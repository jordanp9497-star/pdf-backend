/**
 * Feature overrides (accès test temporaire via Supabase public.feature_overrides).
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';

/**
 * Vérifie si une feature est activée pour un utilisateur (override non expiré).
 * Query: select enabled from public.feature_overrides
 *   where user_id=? and feature_key=? and (expires_at is null OR expires_at > now())
 *   order by created_at desc limit 1
 *
 * @returns true si une ligne existe avec enabled=true, sinon false.
 */
export async function isFeatureEnabled(userId: string, featureKey: string): Promise<boolean> {
  if (!userId || !featureKey) return false;
  try {
    const { data, error } = await supabaseAdmin
      .from('feature_overrides')
      .select('enabled, expires_at')
      .eq('user_id', userId)
      .eq('feature_key', featureKey)
      .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[FEATURES] isFeatureEnabled error:', error);
      return false;
    }
    return data?.enabled === true;
  } catch (err) {
    console.error('[FEATURES] isFeatureEnabled exception:', err);
    return false;
  }
}
