/**
 * Client Supabase Admin (Service Role)
 * 
 * Utilise la clé service role pour les opérations backend
 * qui nécessitent des permissions élevées
 */

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_CONFIG } from '../config/env.js';

export const supabaseAdmin = createClient(
  SUPABASE_CONFIG.url,
  SUPABASE_CONFIG.serviceRoleKey,
  {
    auth: {
      persistSession: false, // Pas de session persistante pour le service role
    }
  }
);

console.log('[SUPABASE] ✅ Client admin initialisé');
