/**
 * Routes pour la gestion des ordonnances
 * 
 * POST /ordonnances/:id/recovered - Marquer une ordonnance comme récupérée
 */

import express from 'express';
import { authenticateSupabase } from '../middlewares/auth.js';
import { supabaseAdmin } from '../src/lib/supabaseAdmin.js';

const router = express.Router();

// Utiliser le client Supabase admin centralisé
const supabase = supabaseAdmin;

/**
 * POST /ordonnances/:id/recovered
 * 
 * Marque une ordonnance comme récupérée
 * - Requiert authentification (Bearer token Supabase)
 * - Valide req.params.id et req.body.recoveredAt
 * - Met à jour recovered_at dans la table ordonnances
 * - Si l'ordonnance n'existe pas, la crée à la volée (MVP)
 * 
 * Body: { 
 *   recoveredAt: string (ISO date),
 *   ordonnance?: object (optionnel, données supplémentaires à stocker dans data)
 * }
 * Retourne: { 
 *   ok: true, 
 *   ordonnanceId: string, 
 *   recoveredAt: string,
 *   created: boolean (true si créée, false si mise à jour)
 * }
 */
router.post('/:id/recovered',
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

      // Valider req.params.id
      const ordonnanceId = req.params.id;
      if (!ordonnanceId || typeof ordonnanceId !== 'string' || ordonnanceId.trim() === '') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'ID d\'ordonnance invalide'
        });
      }

      // Valider req.body.recoveredAt
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Body doit être un objet JSON'
        });
      }

      const { recoveredAt, ordonnance } = req.body;
      if (!recoveredAt || typeof recoveredAt !== 'string' || recoveredAt.trim() === '') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Le champ "recoveredAt" (string ISO date) est requis'
        });
      }

      // Valider le format de date ISO
      const recoveredAtDate = new Date(recoveredAt);
      if (isNaN(recoveredAtDate.getTime())) {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Le champ "recoveredAt" doit être une date ISO valide'
        });
      }

      // Optionnel: valider le champ ordonnance si fourni
      let ordonnanceData = {};
      if (ordonnance && typeof ordonnance === 'object') {
        ordonnanceData = ordonnance;
      }

      // Utiliser req.userId (défini par authenticateSupabase)
      const userId = req.userId || req.user?.id;
      
      if (!userId) {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'Authentification requise'
        });
      }

      console.log('[ORDONNANCES] POST /ordonnances/:id/recovered', {
        ordonnanceId,
        userId,
        recoveredAt
      });

      // Vérifier que Supabase est configuré
      if (!supabase) {
        console.error('[ORDONNANCES] ❌ Supabase admin client non initialisé');
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la mise à jour de l\'ordonnance'
        });
      }

      try {
        // 1. Vérifier si l'ordonnance existe déjà pour déterminer si c'est une création
        const { data: existingOrdonnance, error: checkError } = await supabase
          .from('ordonnances')
          .select('id')
          .eq('id', ordonnanceId)
          .eq('user_id', userId)
          .maybeSingle();

        if (checkError) {
          // Logger l'erreur Supabase complète
          console.error('[ORDONNANCES] Error checking existing ordonnance - Supabase error complete:', {
            ordonnanceId,
            userId,
            errorCode: checkError.code,
            errorMessage: checkError.message,
            errorDetails: checkError.details,
            errorHint: checkError.hint
          });

          // Vérifier si c'est une erreur de table manquante
          if (checkError.code === '42P01' || 
              checkError.message?.toLowerCase().includes('relation') ||
              checkError.message?.toLowerCase().includes('does not exist') ||
              (checkError.message?.toLowerCase().includes('table') && checkError.message?.toLowerCase().includes('not found'))) {
            console.error('[ORDONNANCES] ❌ Table ordonnances n\'existe pas');
            return res.status(500).json({
              ok: false,
              error: 'ORDONNANCES_TABLE_MISSING',
              message: 'La table ordonnances n\'existe pas dans la base de données'
            });
          }

          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la vérification de l\'ordonnance'
          });
        }

        const isCreated = !existingOrdonnance;

        // 2. Upsert l'ordonnance (id, user_id, recovered_at)
        const now = new Date().toISOString();
        const { data: upsertData, error: upsertError } = await supabase
          .from('ordonnances')
          .upsert({
            id: ordonnanceId,
            user_id: userId,
            recovered_at: recoveredAt,
            updated_at: now
          }, {
            onConflict: 'id',
            ignoreDuplicates: false
          })
          .select('id, recovered_at')
          .single();

        if (upsertError) {
          // Logger l'erreur Supabase complète
          console.error('[ORDONNANCES] Error upserting ordonnance - Supabase error complete:', {
            ordonnanceId,
            userId,
            recoveredAt,
            errorCode: upsertError.code,
            errorMessage: upsertError.message,
            errorDetails: upsertError.details,
            errorHint: upsertError.hint
          });

          // Vérifier si c'est une erreur de table manquante
          if (upsertError.code === '42P01' || 
              upsertError.message?.toLowerCase().includes('relation') ||
              upsertError.message?.toLowerCase().includes('does not exist') ||
              (upsertError.message?.toLowerCase().includes('table') && upsertError.message?.toLowerCase().includes('not found'))) {
            console.error('[ORDONNANCES] ❌ Table ordonnances n\'existe pas');
            return res.status(500).json({
              ok: false,
              error: 'ORDONNANCES_TABLE_MISSING',
              message: 'La table ordonnances n\'existe pas dans la base de données'
            });
          }

          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la mise à jour de l\'ordonnance'
          });
        }

        // 3. Créer l'audit log
        try {
          await supabase
            .from('audit_log')
            .insert({
              actor_user_id: userId,
              patient_user_id: userId,
              action: 'ORDONNANCE_MARK_RECOVERED',
              entity_type: 'ordonnance',
              entity_id: ordonnanceId,
              metadata: {
                recoveredAt: recoveredAt,
                created: isCreated
              },
              created_at: now
            });

          console.log(`[ORDONNANCES] ✅ Audit log créé (created: ${isCreated})`);
        } catch (auditError) {
          // Log l'erreur mais ne bloque pas la réponse
          console.error('[ORDONNANCES] ⚠️ Erreur lors de la création de l\'audit log:', auditError);
        }

        // 4. Retourner succès
        console.log(`[ORDONNANCES] ✅ Ordonnance ${isCreated ? 'créée' : 'mise à jour'}`, {
          ordonnanceId,
          userId,
          recoveredAt,
          created: isCreated
        });

        return res.status(200).json({
          ok: true,
          ordonnanceId: ordonnanceId,
          recoveredAt: recoveredAt,
          created: isCreated
        });

      } catch (dbError) {
        // Log détaillé de l'exception
        console.error('[ORDONNANCES] update recovered failed', {
          id: ordonnanceId,
          userId: userId,
          recoveredAt: recoveredAt,
          errorMessage: dbError?.message,
          errorDetails: dbError?.details,
          errorHint: dbError?.hint,
          errorStack: dbError?.stack
        });

        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la mise à jour de l\'ordonnance'
        });
      }

    } catch (error) {
      console.error('[ORDONNANCES] ❌ Erreur inattendue:', error);
      
      // Réponse 500 avec debug en DEV
      const response = {
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de la mise à jour de l\'ordonnance'
      };

      // Ajouter debug en DEV uniquement
      if (process.env.NODE_ENV !== 'production') {
        response.debug = {
          message: error?.message || 'Unknown error',
          stack: error?.stack || null
        };
      }

      return res.status(500).json(response);
    }
  }
);

export default router;
