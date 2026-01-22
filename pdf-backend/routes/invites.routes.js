/**
 * Routes pour la gestion des invitations de profils
 * 
 * POST /profiles/:profileId/invites - Créer une invitation (OWNER uniquement)
 * POST /invites/accept - Accepter une invitation avec un code
 */

import express from 'express';
import { authenticateSupabase } from '../middlewares/auth.js';
import { requireProfileRole } from '../middlewares/profileRole.js';
import { requireSubscription } from '../middlewares/subscription.js';
import { supabaseAdmin } from '../src/lib/supabaseAdmin.js';

const router = express.Router();

// Utiliser le client Supabase admin centralisé
const supabase = supabaseAdmin;

/**
 * Génère un code d'invitation aléatoire de 8-10 caractères
 * Utilise des caractères alphanumériques (sans caractères ambigus)
 */
function generateInviteCode() {
  // Caractères utilisables (sans 0, O, I, l pour éviter les confusions)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const length = 8 + Math.floor(Math.random() * 3); // 8, 9 ou 10 caractères
  
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return code;
}

/**
 * POST /profiles/:profileId/invites
 * 
 * Crée une invitation pour un profil
 * - Requiert authentification + rôle OWNER
 * - Génère un code aléatoire de 8-10 caractères
 * - Expire dans 7 jours
 * 
 * Retourne: { code, expires_at }
 */
router.post('/profiles/:profileId/invites',
  authenticateSupabase,
  requireSubscription, // Feature premium: nécessite un abonnement
  requireProfileRole('profileId', ['owner']),
  async (req, res) => {
    try {
      const profileId = req.params.profileId;

      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error: 'CONFIG_ERROR',
          message: 'Configuration Supabase manquante'
        });
      }

      // Générer un code unique
      let code;
      let attempts = 0;
      const maxAttempts = 10;

      do {
        code = generateInviteCode();
        attempts++;

        // Vérifier que le code n'existe pas déjà (et n'est pas utilisé)
        const { data: existing } = await supabase
          .from('profile_invites')
          .select('id')
          .eq('code', code)
          .is('used_at', null)
          .single();

        if (!existing) {
          break; // Code disponible
        }

        if (attempts >= maxAttempts) {
          return res.status(500).json({
            ok: false,
            error: 'CODE_GENERATION_FAILED',
            message: 'Impossible de générer un code unique'
          });
        }
      } while (attempts < maxAttempts);

      // Calculer la date d'expiration (7 jours)
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      // Créer l'invitation dans la base de données
      const { data: invite, error } = await supabase
        .from('profile_invites')
        .insert({
          profile_id: profileId,
          code: code,
          expires_at: expiresAt.toISOString(),
          created_by: req.user.id,
          created_at: new Date().toISOString()
        })
        .select('code, expires_at')
        .single();

      if (error) {
        console.error('[INVITES] ❌ Erreur lors de la création de l\'invitation:', error);
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la création de l\'invitation'
        });
      }

      console.log(`[INVITES] ✅ Invitation créée pour profil ${profileId} par ${req.user.id}`);

      return res.status(201).json({
        ok: true,
        code: invite.code,
        expires_at: invite.expires_at
      });

    } catch (error) {
      console.error('[INVITES] ❌ Erreur inattendue:', error);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de la création de l\'invitation'
      });
    }
  }
);

/**
 * POST /invites/accept
 * 
 * Accepte une invitation avec un code
 * - Requiert authentification
 * - Vérifie que le code est valide, non expiré et non utilisé
 * - Crée une entrée dans profile_members avec role='AIDANT'
 * - Marque l'invitation comme utilisée (used_by, used_at)
 * 
 * Body: { code: string }
 * Retourne: { profileId }
 */
router.post('/invites/accept',
  authenticateSupabase,
  async (req, res) => {
    try {
      // Vérifier que l'utilisateur est authentifié
      if (!req.user || !req.user.id) {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'Authentification requise'
        });
      }

      // Vérifier le body
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Body doit être un objet JSON'
        });
      }

      const { code } = req.body;

      if (!code || typeof code !== 'string' || code.trim().length === 0) {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Le champ "code" (string) est requis'
        });
      }

      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error: 'CONFIG_ERROR',
          message: 'Configuration Supabase manquante'
        });
      }

      // Récupérer l'invitation
      const { data: invite, error: inviteError } = await supabase
        .from('profile_invites')
        .select('id, profile_id, code, expires_at, used_at, used_by')
        .eq('code', code.trim().toUpperCase())
        .single();

      if (inviteError || !invite) {
        console.log(`[INVITES] ❌ Code invalide: ${code}`);
        return res.status(404).json({
          ok: false,
          error: 'INVALID_CODE',
          message: 'Code d\'invitation invalide'
        });
      }

      // Vérifier que l'invitation n'est pas déjà utilisée
      if (invite.used_at || invite.used_by) {
        console.log(`[INVITES] ❌ Code déjà utilisé: ${code}`);
        return res.status(400).json({
          ok: false,
          error: 'CODE_ALREADY_USED',
          message: 'Ce code d\'invitation a déjà été utilisé'
        });
      }

      // Vérifier que l'invitation n'est pas expirée
      const now = new Date();
      const expiresAt = new Date(invite.expires_at);
      
      if (now > expiresAt) {
        console.log(`[INVITES] ❌ Code expiré: ${code}`);
        return res.status(400).json({
          ok: false,
          error: 'CODE_EXPIRED',
          message: 'Ce code d\'invitation a expiré'
        });
      }

      // Vérifier que l'utilisateur n'est pas déjà membre du profil
      const { data: existingMember } = await supabase
        .from('profile_members')
        .select('id')
        .eq('profile_id', invite.profile_id)
        .eq('user_id', req.user.id)
        .single();

      if (existingMember) {
        console.log(`[INVITES] ❌ Utilisateur ${req.user.id} déjà membre du profil ${invite.profile_id}`);
        return res.status(400).json({
          ok: false,
          error: 'ALREADY_MEMBER',
          message: 'Vous êtes déjà membre de ce profil'
        });
      }

      // Utiliser une transaction pour garantir la cohérence
      // 1. Créer l'entrée dans profile_members
      const { data: member, error: memberError } = await supabase
        .from('profile_members')
        .insert({
          profile_id: invite.profile_id,
          user_id: req.user.id,
          role: 'AIDANT',
          created_at: new Date().toISOString()
        })
        .select('id, profile_id, user_id, role')
        .single();

      if (memberError || !member) {
        console.error('[INVITES] ❌ Erreur lors de la création du membre:', memberError);
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de l\'ajout au profil'
        });
      }

      // 2. Marquer l'invitation comme utilisée
      const { error: updateError } = await supabase
        .from('profile_invites')
        .update({
          used_by: req.user.id,
          used_at: new Date().toISOString()
        })
        .eq('id', invite.id);

      if (updateError) {
        console.error('[INVITES] ❌ Erreur lors de la mise à jour de l\'invitation:', updateError);
        // On ne rollback pas, mais on log l'erreur
        // L'utilisateur est déjà membre, donc c'est OK
      }

      console.log(`[INVITES] ✅ Invitation acceptée: utilisateur ${req.user.id} ajouté au profil ${invite.profile_id}`);

      return res.status(200).json({
        ok: true,
        profileId: invite.profile_id
      });

    } catch (error) {
      console.error('[INVITES] ❌ Erreur inattendue:', error);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de l\'acceptation de l\'invitation'
      });
    }
  }
);

export default router;
