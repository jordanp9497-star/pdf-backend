/**
 * Middleware pour vérifier les permissions de profil
 *
 * Vérifie que l'utilisateur authentifié (req.user.id) est membre
 * du profil spécifié avec un rôle autorisé dans la table profile_members
 */

import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { supabaseAdmin } from '../src/lib/supabaseAdmin.js';

// Utiliser le client Supabase admin centralisé
const supabase = supabaseAdmin;

/**
 * Middleware pour vérifier les permissions de profil
 *
 * @param profileIdParamName - Nom du paramètre/body contenant le profile_id
 * @param rolesAllowed - Liste des rôles autorisés (ex: ['owner', 'admin', 'member'])
 *
 * Usage:
 *   router.post('/profiles/:profileId/action',
 *     authenticateSupabase,
 *     requireProfileRole('profileId', ['owner', 'admin']),
 *     handler
 *   );
 *
 *   router.post('/action',
 *     authenticateSupabase,
 *     requireProfileRole('profile_id', ['owner']),
 *     handler
 *   );
 */
export const requireProfileRole = (profileIdParamName: string, rolesAllowed: string[] = []) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Vérifier que l'utilisateur est authentifié
      if (!req.user || !req.user.id) {
        res.status(401).json({
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'Authentification requise'
        });
        return;
      }

      // Vérifier que Supabase est configuré
      if (!supabase) {
        console.error('[PROFILE_ROLE] ❌ Supabase non configuré');
        res.status(500).json({
          ok: false,
          error: 'CONFIG_ERROR',
          message: 'Configuration Supabase manquante'
        });
        return;
      }

      // Récupérer le profile_id depuis req.params ou req.body
      let profileId: string | null = null;

      // Chercher dans req.params d'abord
      if (req.params && req.params[profileIdParamName]) {
        profileId = req.params[profileIdParamName];
      }
      // Sinon chercher dans req.body
      else if (req.body && req.body[profileIdParamName]) {
        profileId = req.body[profileIdParamName];
      }

      if (!profileId) {
        res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: `Paramètre ${profileIdParamName} manquant (attendu dans params ou body)`
        });
        return;
      }

      // Vérifier dans la table profile_members
      const { data: membership, error } = await supabase
        .from('profile_members')
        .select('role, user_id, profile_id')
        .eq('profile_id', profileId)
        .eq('user_id', req.user.id)
        .single();

      if (error) {
        // Si l'erreur est "PGRST116" (no rows returned), l'utilisateur n'est pas membre
        if (error.code === 'PGRST116' || error.message?.includes('No rows')) {
          console.log(`[PROFILE_ROLE] ❌ Utilisateur ${req.user.id} n'est pas membre du profil ${profileId}`);
          res.status(403).json({
            ok: false,
            error: 'FORBIDDEN',
            message: 'Vous n\'êtes pas membre de ce profil'
          });
          return;
        }

        // Autre erreur (problème de connexion, etc.)
        console.error('[PROFILE_ROLE] ❌ Erreur lors de la vérification:', error);
        res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la vérification des permissions'
        });
        return;
      }

      if (!membership) {
        console.log(`[PROFILE_ROLE] ❌ Utilisateur ${req.user.id} n'est pas membre du profil ${profileId}`);
        res.status(403).json({
          ok: false,
          error: 'FORBIDDEN',
          message: 'Vous n\'êtes pas membre de ce profil'
        });
        return;
      }

      // Vérifier que le rôle est autorisé
      const userRole = membership.role;

      if (rolesAllowed.length > 0 && !rolesAllowed.includes(userRole)) {
        console.log(`[PROFILE_ROLE] ❌ Rôle insuffisant: ${userRole} (requis: ${rolesAllowed.join(', ')})`);
        res.status(403).json({
          ok: false,
          error: 'FORBIDDEN',
          message: `Rôle insuffisant. Rôle actuel: ${userRole}. Rôles autorisés: ${rolesAllowed.join(', ')}`
        });
        return;
      }

      // Ajouter les infos de membership à req pour utilisation dans les handlers
      req.profileMembership = {
        profileId: membership.profile_id,
        userId: membership.user_id,
        role: membership.role
      };

      console.log(`[PROFILE_ROLE] ✅ Utilisateur ${req.user.id} autorisé (rôle: ${userRole}) pour profil ${profileId}`);
      next();

    } catch (error) {
      console.error('[PROFILE_ROLE] ❌ Erreur inattendue:', error);
      res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de la vérification des permissions'
      });
    }
  };
};
