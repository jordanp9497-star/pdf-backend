/**
 * Middleware d'authentification Supabase robuste
 * 
 * Vérifie le token JWT dans le header Authorization: Bearer <token>
 * et définit req.user = { id } et req.userId = user.id si le token est valide
 * 
 * Utilise SUPABASE_URL et SUPABASE_ANON_KEY depuis process.env
 */

import { createClient } from '@supabase/supabase-js';

// Initialiser le client Supabase (lecture seule pour vérifier les tokens)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('[AUTH] ⚠️ Variables SUPABASE_URL ou SUPABASE_ANON_KEY non définies');
  console.warn('[AUTH] ⚠️ SUPABASE_URL:', supabaseUrl ? '✅ présent' : '❌ absent');
  console.warn('[AUTH] ⚠️ SUPABASE_ANON_KEY:', supabaseAnonKey ? '✅ présent' : '❌ absent');
  console.warn('[AUTH] L\'authentification Supabase ne fonctionnera pas');
}

const supabase = supabaseUrl && supabaseAnonKey 
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

if (supabase) {
  console.log('[AUTH] ✅ Client Supabase initialisé pour l\'authentification');
  console.log('[AUTH] SUPABASE_URL:', supabaseUrl);
}

/**
 * Middleware pour vérifier l'authentification Supabase
 * 
 * Extrait le token du header Authorization: Bearer <token>
 * Vérifie le token avec Supabase
 * Définit req.user = { id } et req.userId = user.id si valide
 * 
 * Usage:
 *   app.use('/api', authenticateSupabase);
 *   ou
 *   router.post('/route', authenticateSupabase, handler);
 */
export const authenticateSupabase = async (req, res, next) => {
  try {
    // Si Supabase n'est pas configuré, refuser l'accès
    if (!supabase) {
      console.error('[AUTH] ❌ Supabase non configuré, authentification impossible');
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise'
      });
    }

    // Extraire le token du header Authorization
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      console.log('[AUTH] Missing Authorization header');
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise'
      });
    }

    // Vérifier le format "Bearer <token>"
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      console.log('[AUTH] Invalid Authorization format (expected: Bearer <token>)');
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise'
      });
    }

    const token = parts[1];

    if (!token || token.trim() === '') {
      console.log('[AUTH] Token missing after Bearer');
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise'
      });
    }

    // Log DEBUG: token reçu (longueur seulement)
    console.log(`[AUTH] Token received (len=${token.length})`);

    // Vérifier le token avec Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error) {
      console.error('[AUTH] ❌ Error during getUser:', error.message);
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise'
      });
    }

    if (!user) {
      console.log('[AUTH] ❌ User not found (token invalid or expired)');
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise'
      });
    }

    // Définir req.user et req.userId
    req.user = {
      id: user.id
    };
    req.userId = user.id;

    // Log DEBUG: utilisateur authentifié
    console.log(`[AUTH] ✅ User authenticated: ${user.id}`);
    next();

  } catch (error) {
    console.error('[AUTH] ❌ Erreur lors de la vérification du token:', error);
    return res.status(500).json({
      ok: false,
      error: 'AUTH_ERROR',
      message: 'Erreur lors de la vérification de l\'authentification'
    });
  }
};

/**
 * Middleware optionnel pour routes publiques (ne fait rien)
 * Utile pour marquer explicitement qu'une route est publique
 */
export const publicRoute = (req, res, next) => {
  next();
};
