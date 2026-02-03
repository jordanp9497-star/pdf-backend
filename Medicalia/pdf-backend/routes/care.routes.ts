/**
 * Routes pour la gestion des liens patient <-> aidant
 *
 * POST /care/invite - Inviter un aidant (patient)
 * POST /care/accept - Accepter une invitation (aidant)
 * POST /care/revoke - Révoquer un lien (patient)
 */

import express, { Request, Response } from 'express';
import { authenticateSupabase } from '../middlewares/auth.js';
import { requireEntitlement } from '../middlewares/requireEntitlement.js';
import { supabaseAdmin } from '../src/lib/supabaseAdmin.js';

const router = express.Router();

// Utiliser le client Supabase admin centralisé
const supabase = supabaseAdmin;

/**
 * POST /care/invite
 *
 * Invite un aidant par email
 * - Requiert authentification (req.userId = patient)
 * - Recherche l'aidant par email dans auth.users
 * - Crée un lien care_links avec status='pending'
 *
 * Body: {
 *   caregiverEmail: string,
 *   role?: string (optionnel, défaut: 'AIDANT')
 * }
 * Retourne: { ok: true, linkId: string }
 */
router.post('/invite',
  authenticateSupabase,
  requireEntitlement('devices'), // Vérifier la limite d'appareils
  async (req: Request, res: Response) => {
    try {
      // Vérifier que l'utilisateur est authentifié
      const patientUserId = (req as any).userId || (req as any).user?.id;
      if (!patientUserId) {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'Authentification requise'
        });
      }

      // Valider le body
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Body doit être un objet JSON'
        });
      }

      const { caregiverEmail, role } = req.body;

      // Valider caregiverEmail
      if (!caregiverEmail || typeof caregiverEmail !== 'string' || caregiverEmail.trim() === '') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Le champ "caregiverEmail" est requis'
        });
      }

      const normalizedEmail = caregiverEmail.trim().toLowerCase();
      const linkRole = role || 'AIDANT';

      console.log('[CARE] POST /care/invite', {
        patientUserId,
        caregiverEmail: normalizedEmail,
        role: linkRole
      });

      // Vérifier que Supabase est configuré
      if (!supabase) {
        console.error('[CARE] ❌ Supabase admin client non initialisé');
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la création de l\'invitation'
        });
      }

      try {
        // 1. Rechercher l'aidant par email dans auth.users
        // Note: listUsers() peut être lourd avec beaucoup d'utilisateurs
        // Alternative: utiliser une table profiles avec index sur email
        const { data: authUsers, error: authError } = await supabase.auth.admin.listUsers();

        if (authError) {
          console.error('[CARE] Error listing users:', {
            errorMessage: authError.message,
            errorDetails: (authError as any).details
          });
          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la recherche de l\'aidant'
          });
        }

        // Trouver l'utilisateur par email (case-insensitive)
        const caregiverUser = authUsers?.users?.find(
          (user: any) => user.email?.toLowerCase() === normalizedEmail
        );

        if (!caregiverUser) {
          console.log(`[CARE] ❌ Aucun utilisateur trouvé avec l'email ${normalizedEmail}`);
          return res.status(404).json({
            ok: false,
            error: 'NOT_FOUND',
            message: 'Aucun utilisateur trouvé avec cet email'
          });
        }

        const caregiverUserId = caregiverUser.id;

        // Vérifier qu'on ne s'invite pas soi-même
        if (caregiverUserId === patientUserId) {
          return res.status(400).json({
            ok: false,
            error: 'BAD_REQUEST',
            message: 'Vous ne pouvez pas vous inviter vous-même'
          });
        }

        // 2. Vérifier si un lien existe déjà
        const { data: existingLink, error: checkError } = await supabase
          .from('care_links')
          .select('id, status')
          .eq('patient_user_id', patientUserId)
          .eq('caregiver_user_id', caregiverUserId)
          .maybeSingle();

        if (checkError) {
          console.error('[CARE] Error checking existing link:', checkError);
          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la vérification du lien existant'
          });
        }

        // Si un lien actif existe déjà
        if (existingLink && existingLink.status === 'active') {
          return res.status(400).json({
            ok: false,
            error: 'BAD_REQUEST',
            message: 'Un lien actif existe déjà avec cet aidant'
          });
        }

        // Si un lien pending existe, le réutiliser
        if (existingLink && existingLink.status === 'pending') {
          console.log('[CARE] Lien pending existant réutilisé', {
            linkId: existingLink.id,
            patientUserId,
            caregiverUserId
          });

          return res.status(200).json({
            ok: true,
            linkId: existingLink.id
          });
        }

        // 3. Créer le nouveau lien
        const { data: newLink, error: insertError } = await supabase
          .from('care_links')
          .insert({
            patient_user_id: patientUserId,
            caregiver_user_id: caregiverUserId,
            status: 'pending',
            role: linkRole,
            created_at: new Date().toISOString()
          })
          .select('id')
          .single();

        if (insertError) {
          console.error('[CARE] Error creating care link:', {
            patientUserId,
            caregiverUserId,
            errorMessage: insertError.message,
            errorDetails: insertError.details,
            errorHint: insertError.hint,
            errorCode: insertError.code
          });

          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la création de l\'invitation'
          });
        }

        console.log('[CARE] ✅ Invitation créée', {
          linkId: newLink.id,
          patientUserId,
          caregiverUserId,
          role: linkRole
        });

        return res.status(200).json({
          ok: true,
          linkId: newLink.id
        });

      } catch (dbError: any) {
        console.error('[CARE] ❌ Erreur inattendue lors de l\'invitation:', {
          patientUserId,
          caregiverEmail: normalizedEmail,
          errorMessage: dbError?.message,
          errorStack: dbError?.stack
        });

        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la création de l\'invitation'
        });
      }

    } catch (error) {
      console.error('[CARE] ❌ Erreur inattendue:', error);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de la création de l\'invitation'
      });
    }
  }
);

/**
 * POST /care/accept
 *
 * Accepte une invitation d'aidant
 * - Requiert authentification (req.userId = aidant)
 * - Met à jour le lien avec status='active'
 *
 * Body: { linkId: string }
 * Retourne: { ok: true }
 */
router.post('/accept',
  authenticateSupabase,
  async (req: Request, res: Response) => {
    try {
      // Vérifier que l'utilisateur est authentifié
      const caregiverUserId = (req as any).userId || (req as any).user?.id;
      if (!caregiverUserId) {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'Authentification requise'
        });
      }

      // Valider le body
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Body doit être un objet JSON'
        });
      }

      const { linkId } = req.body;

      // Valider linkId
      if (!linkId || typeof linkId !== 'string' || linkId.trim() === '') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Le champ "linkId" est requis'
        });
      }

      console.log('[CARE] POST /care/accept', {
        linkId,
        caregiverUserId
      });

      // Vérifier que Supabase est configuré
      if (!supabase) {
        console.error('[CARE] ❌ Supabase admin client non initialisé');
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de l\'acceptation de l\'invitation'
        });
      }

      try {
        // Mettre à jour le lien (sécurisé: vérifier que l'aidant correspond)
        const { data: updatedLink, error: updateError } = await supabase
          .from('care_links')
          .update({
            status: 'active',
            accepted_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', linkId)
          .eq('caregiver_user_id', caregiverUserId) // Sécurité: s'assurer que l'aidant correspond
          .eq('status', 'pending') // Sécurité: seulement les liens pending peuvent être acceptés
          .select('id')
          .single();

        if (updateError) {
          console.error('[CARE] Error accepting link:', {
            linkId,
            caregiverUserId,
            errorMessage: updateError.message,
            errorDetails: updateError.details,
            errorHint: updateError.hint,
            errorCode: updateError.code
          });

          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de l\'acceptation de l\'invitation'
          });
        }

        // Vérifier si aucune ligne n'a été mise à jour
        if (!updatedLink) {
          console.log(`[CARE] ❌ Lien ${linkId} non trouvé, déjà accepté, ou n'appartient pas à l'aidant ${caregiverUserId}`);
          return res.status(404).json({
            ok: false,
            error: 'NOT_FOUND',
            message: 'Lien non trouvé, déjà accepté, ou vous n\'avez pas les permissions'
          });
        }

        console.log('[CARE] ✅ Invitation acceptée', {
          linkId: updatedLink.id,
          caregiverUserId
        });

        return res.status(200).json({
          ok: true
        });

      } catch (dbError: any) {
        console.error('[CARE] ❌ Erreur inattendue lors de l\'acceptation:', {
          linkId,
          caregiverUserId,
          errorMessage: dbError?.message,
          errorStack: dbError?.stack
        });

        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de l\'acceptation de l\'invitation'
        });
      }

    } catch (error) {
      console.error('[CARE] ❌ Erreur inattendue:', error);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de l\'acceptation de l\'invitation'
      });
    }
  }
);

/**
 * POST /care/revoke
 *
 * Révoque un lien patient-aidant
 * - Requiert authentification (req.userId = patient)
 * - Met à jour le lien avec status='revoked'
 *
 * Body: { linkId: string }
 * Retourne: { ok: true }
 */
router.post('/revoke',
  authenticateSupabase,
  async (req: Request, res: Response) => {
    try {
      // Vérifier que l'utilisateur est authentifié
      const patientUserId = (req as any).userId || (req as any).user?.id;
      if (!patientUserId) {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'Authentification requise'
        });
      }

      // Valider le body
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Body doit être un objet JSON'
        });
      }

      const { linkId } = req.body;

      // Valider linkId
      if (!linkId || typeof linkId !== 'string' || linkId.trim() === '') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Le champ "linkId" est requis'
        });
      }

      console.log('[CARE] POST /care/revoke', {
        linkId,
        patientUserId
      });

      // Vérifier que Supabase est configuré
      if (!supabase) {
        console.error('[CARE] ❌ Supabase admin client non initialisé');
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la révocation du lien'
        });
      }

      try {
        // Mettre à jour le lien (sécurisé: vérifier que le patient correspond)
        const { data: updatedLink, error: updateError } = await supabase
          .from('care_links')
          .update({
            status: 'revoked',
            revoked_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', linkId)
          .eq('patient_user_id', patientUserId) // Sécurité: s'assurer que le patient correspond
          .select('id')
          .single();

        if (updateError) {
          console.error('[CARE] Error revoking link:', {
            linkId,
            patientUserId,
            errorMessage: updateError.message,
            errorDetails: updateError.details,
            errorHint: updateError.hint,
            errorCode: updateError.code
          });

          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la révocation du lien'
          });
        }

        // Vérifier si aucune ligne n'a été mise à jour
        if (!updatedLink) {
          console.log(`[CARE] ❌ Lien ${linkId} non trouvé ou n'appartient pas au patient ${patientUserId}`);
          return res.status(404).json({
            ok: false,
            error: 'NOT_FOUND',
            message: 'Lien non trouvé ou vous n\'avez pas les permissions'
          });
        }

        console.log('[CARE] ✅ Lien révoqué', {
          linkId: updatedLink.id,
          patientUserId
        });

        return res.status(200).json({
          ok: true
        });

      } catch (dbError: any) {
        console.error('[CARE] ❌ Erreur inattendue lors de la révocation:', {
          linkId,
          patientUserId,
          errorMessage: dbError?.message,
          errorStack: dbError?.stack
        });

        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la révocation du lien'
        });
      }

    } catch (error) {
      console.error('[CARE] ❌ Erreur inattendue:', error);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de la révocation du lien'
      });
    }
  }
);

export default router;
