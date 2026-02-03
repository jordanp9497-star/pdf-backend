/**
 * Middleware d'authentification Supabase robuste
 *
 * Vérifie le token JWT dans le header Authorization: Bearer <token>
 * et définit req.userId = user.id et req.user = user si le token est valide
 *
 * Utilise SUPABASE_URL et SUPABASE_ANON_KEY depuis process.env
 * IMPORTANT: SUPABASE_URL doit être du même projet que le token (iss)
 * Format attendu: https://paspjmhyndqnatsmcjtu.supabase.co (sans /auth/v1)
 */

import type { Request, Response, NextFunction } from 'express';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

/** Extend Express Request with custom auth properties */
export interface AuthenticatedRequest extends Request {
  userId?: string;
  user?: User;
  profileMembership?: {
    profileId: string;
    userId: string;
    role: string;
  };
}

// Nettoyer SUPABASE_URL (enlever /auth/v1 si présent)
function cleanSupabaseUrl(url: string): string {
  // Enlever /auth/v1 ou tout autre suffixe de chemin
  return url.replace(/\/auth\/v1\/?$/, '').replace(/\/$/, '');
}

// Initialiser le client Supabase (lecture seule pour vérifier les tokens)
const rawSupabaseUrl = process.env.SUPABASE_URL;
const supabaseUrl = rawSupabaseUrl ? cleanSupabaseUrl(rawSupabaseUrl) : null;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('[AUTH] ⚠️ Variables SUPABASE_URL ou SUPABASE_ANON_KEY non définies');
  console.warn('[AUTH] ⚠️ SUPABASE_URL:', supabaseUrl ? '✅ présent' : '❌ absent');
  console.warn('[AUTH] ⚠️ SUPABASE_ANON_KEY:', supabaseAnonKey ? '✅ présent' : '❌ absent');
  console.warn('[AUTH] L\'authentification Supabase ne fonctionnera pas');
}

const supabase: SupabaseClient | null = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    })
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
export const authenticateSupabase = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Si Supabase n'est pas configuré, refuser l'accès
    if (!supabase) {
      console.error('[AUTH] ❌ Supabase non configuré, authentification impossible');
      console.error('[AUTH] Vérifiez que SUPABASE_URL et SUPABASE_ANON_KEY sont définis dans les variables d\'environnement');
      res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise'
      });
      return;
    }

    // Extraire le token du header Authorization
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      console.log('[AUTH] missing token');
      res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise'
      });
      return;
    }

    // Vérifier le format "Bearer <token>"
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      console.log('[AUTH] missing token (format invalide: doit être "Bearer <token>")');
      res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise'
      });
      return;
    }

    const token = parts[1];

    if (!token || token.trim() === '') {
      console.log('[AUTH] missing token (token vide)');
      res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise'
      });
      return;
    }

    // Vérifier le token avec Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error) {
      console.log(`[AUTH] invalid token: ${error.message}`);
      res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise'
      });
      return;
    }

    if (!user) {
      console.log('[AUTH] invalid token (user not found)');
      res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise'
      });
      return;
    }

    // Définir req.userId et req.user (objet user complet)
    req.userId = user.id;
    req.user = user;

    // Log succès: userId récupéré
    console.log(`[AUTH] userId=${user.id}`);
    next();

  } catch (error) {
    console.error('[AUTH] ❌ Erreur lors de la vérification du token:', error);
    res.status(500).json({
      ok: false,
      error: 'AUTH_ERROR',
      message: 'Erreur lors de la vérification de l\'authentification'
    });
  }
};

/**
 * Alias pour les routes qui exigent un utilisateur authentifié.
 * Même comportement que authenticateSupabase : Bearer token → req.userId.
 */
export const requireUser = authenticateSupabase;

/**
 * Middleware optionnel pour routes publiques (ne fait rien)
 * Utile pour marquer explicitement qu'une route est publique
 */
export const publicRoute = (_req: Request, _res: Response, next: NextFunction): void => {
  next();
};
