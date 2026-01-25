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
        // 1. Essayer d'abord de mettre à jour l'ordonnance existante
        const { data: updateData, error: updateError } = await supabase
          .from('ordonnances')
          .update({
            recovered_at: recoveredAt,
            updated_at: new Date().toISOString()
          })
          .eq('id', ordonnanceId)
          .eq('user_id', userId) // Sécurité: s'assurer que l'ordonnance appartient à l'utilisateur
          .select('id');

        if (updateError) {
          // Log détaillé de l'erreur
          console.error('[ORDONNANCES] update recovered failed', {
            id: ordonnanceId,
            userId: userId,
            recoveredAt: recoveredAt,
            errorMessage: updateError.message,
            errorDetails: updateError.details,
            errorHint: updateError.hint,
            errorCode: updateError.code
          });

          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la mise à jour de l\'ordonnance'
          });
        }

        // 2. Si l'ordonnance existe (update réussi), retourner succès
        if (updateData && updateData.length > 0) {
          console.log('[ORDONNANCES] recovered updated', {
            id: ordonnanceId,
            userId: userId,
            recoveredAt: recoveredAt,
            created: false
          });

          return res.status(200).json({
            ok: true,
            ordonnanceId: ordonnanceId,
            recoveredAt: recoveredAt,
            created: false
          });
        }

        // 3. Si aucune ligne n'a été mise à jour (0 rows), créer l'ordonnance à la volée
        console.log(`[ORDONNANCES] Ordonnance ${ordonnanceId} non trouvée, création à la volée pour userId ${userId}`);
        
        const { data: insertData, error: insertError } = await supabase
          .from('ordonnances')
          .upsert({
            id: ordonnanceId,
            user_id: userId,
            recovered_at: recoveredAt,
            category: 'MEDICAMENT',
            data: ordonnanceData,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .select('id');

        if (insertError) {
          // Log détaillé de l'erreur d'insertion
          console.error('[ORDONNANCES] insert recovered failed', {
            id: ordonnanceId,
            userId: userId,
            recoveredAt: recoveredAt,
            errorMessage: insertError.message,
            errorDetails: insertError.details,
            errorHint: insertError.hint,
            errorCode: insertError.code
          });

          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la création de l\'ordonnance'
          });
        }

        // 4. Succès: ordonnance créée
        console.log('[ORDONNANCES] recovered created', {
          id: ordonnanceId,
          userId: userId,
          recoveredAt: recoveredAt,
          created: true
        });

        return res.status(200).json({
          ok: true,
          ordonnanceId: ordonnanceId,
          recoveredAt: recoveredAt,
          created: true
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
