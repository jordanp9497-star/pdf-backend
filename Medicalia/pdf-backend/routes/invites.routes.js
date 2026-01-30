/**
 * Routes pour la gestion des invitations de profils
 * 
 * POST /profiles/:profileId/invites - Créer une invitation (OWNER uniquement) [LEGACY]
 * POST /invites/accept - Accepter une invitation avec un code [LEGACY]
 * POST /invites/create - Créer une invitation avec code hashé (PREMIUM uniquement)
 * POST /invites/redeem - Utiliser un code d'invitation (aidant)
 */

import express from 'express';
import { createHash } from 'crypto';
import { authenticateSupabase } from '../middlewares/auth.js';
import { requireProfileRole } from '../middlewares/profileRole.js';
import { requireSubscription } from '../middlewares/subscription.js';
import { isSubscribed } from './billing.routes.js';
import { supabaseAdmin } from '../src/lib/supabaseAdmin.js';

const router = express.Router();

// Utiliser le client Supabase admin centralisé
const supabase = supabaseAdmin;

// Secret pour le hashing des codes (fallback si non défini)
const INVITE_HASH_SECRET = process.env.INVITE_HASH_SECRET || 'medicalia-invite-secret-v1';

/**
 * Génère un code d'invitation aléatoire de 8 caractères (humain-friendly)
 * Utilise des caractères alphanumériques (sans caractères ambigus)
 */
function generateInviteCode(length = 8) {
  // Caractères utilisables (sans 0, O, I, l pour éviter les confusions)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return code;
}

/**
 * Hash un code d'invitation avec SHA256 + salt secret
 * @param {string} code - Code en clair
 * @returns {string} - Hash hexadécimal
 */
function hashInviteCode(code) {
  const normalized = code.trim().toUpperCase();
  return createHash('sha256')
    .update(normalized + INVITE_HASH_SECRET)
    .digest('hex');
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

// ============================================================================
// NOUVELLES ROUTES V2 : Codes hashés + multi-usage
// ============================================================================

/**
 * POST /invites/create
 * 
 * Crée une invitation avec code hashé (sécurisé)
 * - Requiert authentification
 * - Requiert abonnement PREMIUM
 * - Vérifie que l'utilisateur est OWNER du profil
 * - Génère un code humain (8 chars), stocke seulement le hash
 * - Retourne le code en clair UNE SEULE FOIS
 * 
 * Body: { profile_id: string, expires_at?: string (ISO), max_uses?: number (défaut: 1) }
 * Retourne: { ok: true, code: string, expires_at: string, max_uses: number }
 */
router.post('/invites/create',
  authenticateSupabase,
  async (req, res) => {
    try {
      const userId = req.user?.id;
      
      // 1. Vérifier l'authentification
      if (!userId) {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'Authentification requise'
        });
      }

      // 2. Vérifier l'abonnement PREMIUM
      const subscribed = await isSubscribed(userId);
      if (!subscribed) {
        console.log(`[INVITES] ❌ Utilisateur ${userId} n'est pas PREMIUM`);
        return res.status(403).json({
          ok: false,
          error: 'NOT_PREMIUM_OWNER',
          message: 'Un abonnement Premium est requis pour créer des invitations'
        });
      }

      // 3. Valider le body
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Body doit être un objet JSON'
        });
      }

      const { profile_id, expires_at, max_uses } = req.body;

      if (!profile_id || typeof profile_id !== 'string' || profile_id.trim() === '') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Le champ "profile_id" est requis'
        });
      }

      // 4. Vérifier que l'utilisateur est OWNER du profil
      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error: 'CONFIG_ERROR',
          message: 'Configuration Supabase manquante'
        });
      }

      const { data: membership, error: memberError } = await supabase
        .from('profile_members')
        .select('role')
        .eq('profile_id', profile_id)
        .eq('user_id', userId)
        .single();

      if (memberError || !membership) {
        console.log(`[INVITES] ❌ Utilisateur ${userId} n'est pas membre du profil ${profile_id}`);
        return res.status(403).json({
          ok: false,
          error: 'NOT_PROFILE_MEMBER',
          message: 'Vous n\'êtes pas membre de ce profil'
        });
      }

      if (membership.role !== 'owner' && membership.role !== 'OWNER') {
        console.log(`[INVITES] ❌ Utilisateur ${userId} n'est pas OWNER du profil ${profile_id} (role: ${membership.role})`);
        return res.status(403).json({
          ok: false,
          error: 'NOT_PROFILE_OWNER',
          message: 'Seul le propriétaire du profil peut créer des invitations'
        });
      }

      // 5. Calculer la date d'expiration (défaut: 7 jours)
      let expiresAtDate;
      if (expires_at) {
        expiresAtDate = new Date(expires_at);
        if (isNaN(expiresAtDate.getTime())) {
          return res.status(400).json({
            ok: false,
            error: 'BAD_REQUEST',
            message: 'Le champ "expires_at" doit être une date ISO valide'
          });
        }
      } else {
        expiresAtDate = new Date();
        expiresAtDate.setDate(expiresAtDate.getDate() + 7);
      }

      // 6. Valider max_uses (défaut: 1)
      const maxUsesValue = typeof max_uses === 'number' && max_uses > 0 ? max_uses : 1;

      // 7. Générer un code unique et le hasher
      let code;
      let codeHash;
      let attempts = 0;
      const maxAttempts = 10;

      do {
        code = generateInviteCode(8);
        codeHash = hashInviteCode(code);
        attempts++;

        // Vérifier que le hash n'existe pas déjà
        const { data: existing } = await supabase
          .from('profile_invites_v2')
          .select('id')
          .eq('code_hash', codeHash)
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

      // 8. Créer l'invitation dans la base de données (uniquement le hash)
      const { data: invite, error: insertError } = await supabase
        .from('profile_invites_v2')
        .insert({
          profile_id: profile_id,
          code_hash: codeHash,
          expires_at: expiresAtDate.toISOString(),
          max_uses: maxUsesValue,
          uses_count: 0,
          created_by: userId,
          created_at: new Date().toISOString(),
          revoked: false
        })
        .select('id, expires_at, max_uses')
        .single();

      if (insertError) {
        console.error('[INVITES] ❌ Erreur lors de la création de l\'invitation:', insertError);
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la création de l\'invitation'
        });
      }

      console.log(`[INVITES] ✅ Invitation V2 créée: profile=${profile_id}, userId=${userId}, maxUses=${maxUsesValue}`);

      // 9. Retourner le code en clair UNE SEULE FOIS
      return res.status(201).json({
        ok: true,
        code: code, // Code en clair (jamais stocké)
        expires_at: invite.expires_at,
        max_uses: invite.max_uses
      });

    } catch (error) {
      console.error('[INVITES] ❌ Erreur inattendue /invites/create:', error);
      console.error('[INVITES] Stack:', error?.stack);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de la création de l\'invitation'
      });
    }
  }
);

/**
 * POST /invites/redeem
 * 
 * Utilise un code d'invitation (pour les aidants)
 * - Requiert authentification
 * - Hash le code côté serveur et recherche l'invite valide
 * - Vérifie: non revoked, non expiré, uses_count < max_uses
 * - Crée profile_access (ou profile_members)
 * - Incrémente uses_count
 * - Retourne les infos du profil ajouté
 * 
 * Body: { code: string }
 * Retourne: { ok: true, profile_id: string, profile_name?: string }
 */
router.post('/invites/redeem',
  authenticateSupabase,
  async (req, res) => {
    try {
      const userId = req.user?.id;
      
      // 1. Vérifier l'authentification
      if (!userId) {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'Authentification requise'
        });
      }

      // 2. Valider le body
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Body doit être un objet JSON'
        });
      }

      const { code } = req.body;

      if (!code || typeof code !== 'string' || code.trim() === '') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Le champ "code" est requis'
        });
      }

      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error: 'CONFIG_ERROR',
          message: 'Configuration Supabase manquante'
        });
      }

      // 3. Hasher le code et rechercher l'invitation
      const codeHash = hashInviteCode(code);
      console.log(`[INVITES] Recherche invitation V2 avec hash...`);

      const { data: invite, error: inviteError } = await supabase
        .from('profile_invites_v2')
        .select('id, profile_id, expires_at, max_uses, uses_count, revoked, created_by')
        .eq('code_hash', codeHash)
        .single();

      if (inviteError || !invite) {
        console.log(`[INVITES] ❌ Code invalide (hash non trouvé)`);
        return res.status(400).json({
          ok: false,
          error: 'INVALID_CODE',
          message: 'Code d\'invitation invalide'
        });
      }

      // 4. Vérifier que l'invitation n'est pas révoquée
      if (invite.revoked) {
        console.log(`[INVITES] ❌ Invitation révoquée: ${invite.id}`);
        return res.status(400).json({
          ok: false,
          error: 'REVOKED',
          message: 'Cette invitation a été révoquée'
        });
      }

      // 5. Vérifier que l'invitation n'est pas expirée
      const now = new Date();
      const expiresAt = new Date(invite.expires_at);
      
      if (now > expiresAt) {
        console.log(`[INVITES] ❌ Invitation expirée: ${invite.id}`);
        return res.status(400).json({
          ok: false,
          error: 'EXPIRED',
          message: 'Cette invitation a expiré'
        });
      }

      // 6. Vérifier que l'invitation n'a pas atteint le nombre max d'utilisations
      if (invite.uses_count >= invite.max_uses) {
        console.log(`[INVITES] ❌ Invitation épuisée: ${invite.id} (${invite.uses_count}/${invite.max_uses})`);
        return res.status(400).json({
          ok: false,
          error: 'USED_UP',
          message: 'Cette invitation a atteint le nombre maximum d\'utilisations'
        });
      }

      // 7. Vérifier que l'utilisateur n'est pas déjà membre du profil
      const { data: existingMember } = await supabase
        .from('profile_members')
        .select('id')
        .eq('profile_id', invite.profile_id)
        .eq('user_id', userId)
        .single();

      if (existingMember) {
        console.log(`[INVITES] ❌ Utilisateur ${userId} déjà membre du profil ${invite.profile_id}`);
        return res.status(400).json({
          ok: false,
          error: 'ALREADY_MEMBER',
          message: 'Vous êtes déjà membre de ce profil'
        });
      }

      // 8. Créer l'entrée dans profile_members (role: AIDANT)
      const { data: member, error: memberError } = await supabase
        .from('profile_members')
        .insert({
          profile_id: invite.profile_id,
          user_id: userId,
          role: 'AIDANT',
          created_at: new Date().toISOString()
        })
        .select('id, profile_id')
        .single();

      if (memberError || !member) {
        console.error('[INVITES] ❌ Erreur lors de la création du membre:', memberError);
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de l\'ajout au profil'
        });
      }

      // 9. Incrémenter uses_count
      const { error: updateError } = await supabase
        .from('profile_invites_v2')
        .update({
          uses_count: invite.uses_count + 1
        })
        .eq('id', invite.id);

      if (updateError) {
        console.error('[INVITES] ⚠️ Erreur lors de l\'incrémentation uses_count:', updateError);
        // On ne bloque pas, l'utilisateur est déjà membre
      }

      // 10. Récupérer les infos du profil
      const { data: profile } = await supabase
        .from('profiles')
        .select('id, display_name, first_name, last_name')
        .eq('id', invite.profile_id)
        .single();

      const profileName = profile?.display_name || 
                          [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') ||
                          'Profil';

      console.log(`[INVITES] ✅ Invitation V2 utilisée: user=${userId} rejoint profil=${invite.profile_id}`);

      return res.status(200).json({
        ok: true,
        profile_id: invite.profile_id,
        profile_name: profileName,
        owner_user_id: invite.created_by
      });

    } catch (error) {
      console.error('[INVITES] ❌ Erreur inattendue /invites/redeem:', error);
      console.error('[INVITES] Stack:', error?.stack);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de l\'utilisation de l\'invitation'
      });
    }
  }
);

export default router;
