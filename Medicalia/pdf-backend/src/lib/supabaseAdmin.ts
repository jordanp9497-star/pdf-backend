/**
 * Client Supabase Admin (Service Role)
 *
 * Utilise UNIQUEMENT SUPABASE_SERVICE_ROLE_KEY (pas ANON).
 * Utilisé par import-pdf (Storage), prescriptions, etc.
 */

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_CONFIG } from '../config/env.js';

if (!SUPABASE_CONFIG.serviceRoleKey || SUPABASE_CONFIG.serviceRoleKey.length < 20) {
  throw new Error(
    'Démarrage impossible: SUPABASE_SERVICE_ROLE_KEY est requis pour supabaseAdmin (Storage, import-pdf). Définissez-la dans vos variables d\'environnement.'
  );
}

export const supabaseAdmin = createClient(
  SUPABASE_CONFIG.url,
  SUPABASE_CONFIG.serviceRoleKey,
  {
    auth: {
      persistSession: false,
    },
  }
);

console.log('[SUPABASE] supabaseAdmin: service-role OK');
