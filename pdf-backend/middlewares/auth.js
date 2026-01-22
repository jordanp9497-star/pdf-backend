/**
 * Middleware d'authentification Supabase
 * 
 * Vérifie le token JWT dans le header Authorization: Bearer <token>
 * et définit req.user = { id } si le token est valide
 */

import { createClient } from '@supabase/supabase-js';

// Initialiser le client Supabase (lecture seule pour vérifier les tokens)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('[AUTH] ⚠️ Variables SUPABASE_URL ou SUPABASE_ANON_KEY non définies');
  console.warn('[AUTH] L\'authentification Supabase ne fonctionnera pas');
}

const supabase = supabaseUrl && supabaseAnonKey 
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

/**
 * Middleware pour vérifier l'authentification Supabase
 * 
 * Extrait le token du header Authorization: Bearer <token>
 * Vérifie le token avec Supabase
 * Définit req.user = { id } si valide
 * 
 * Usage:
 *   app.use('/api', authenticateSupabase);
 *   ou
 *   router.post('/route', authenticateSupabase, handler);
 */
export const authenticateSupabase = async (req, res, next) => {
  try {
    // Si Supabase n'est pas configuré, passer sans authentification
    if (!supabase) {
      console.warn('[AUTH] Supabase non configuré, authentification ignorée');
      return next();
    }

    // Extraire le token du header Authorization
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Token d\'authentification manquant'
      });
    }

    // Vérifier le format "Bearer <token>"
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Format du token invalide. Utilisez: Authorization: Bearer <token>'
      });
    }

    const token = parts[1];

    if (!token) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Token manquant'
      });
    }

    // Vérifier le token avec Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      console.log(`[AUTH] ❌ Token invalide: ${error?.message || 'User not found'}`);
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Token invalide ou expiré'
      });
    }

    // Définir req.user avec l'ID de l'utilisateur
    req.user = {
      id: user.id
    };

    console.log(`[AUTH] ✅ Utilisateur authentifié: ${user.id}`);
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
