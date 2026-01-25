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
 * 
 * Body: { recoveredAt: string (ISO date) }
 * Retourne: { ok: true, ordonnanceId: string, recoveredAt: string }
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

      const { recoveredAt } = req.body;
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
        // Mettre à jour l'ordonnance
        const { data, error } = await supabase
          .from('ordonnances')
          .update({
            recovered_at: recoveredAt,
            updated_at: new Date().toISOString()
          })
          .eq('id', ordonnanceId)
          .eq('user_id', userId) // Sécurité: s'assurer que l'ordonnance appartient à l'utilisateur
          .select('id, recovered_at');

        if (error) {
          // Log détaillé de l'erreur
          console.error('[ORDONNANCES] update recovered failed', {
            id: ordonnanceId,
            userId: userId,
            recoveredAt: recoveredAt,
            errorMessage: error.message,
            errorDetails: error.details,
            errorHint: error.hint,
            errorCode: error.code
          });

          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la mise à jour de l\'ordonnance'
          });
        }

        // Vérifier si aucune ligne n'a été mise à jour (0 rows updated)
        if (!data || data.length === 0) {
          console.log(`[ORDONNANCES] ❌ Ordonnance ${ordonnanceId} non trouvée ou n'appartient pas à l'utilisateur ${userId}`);
          return res.status(404).json({
            ok: false,
            error: 'NOT_FOUND',
            message: 'Ordonnance non trouvée ou vous n\'avez pas les permissions'
          });
        }

        // Succès: log et retourner la réponse
        console.log('[ORDONNANCES] recovered updated', {
          id: ordonnanceId,
          userId: userId,
          recoveredAt: data[0].recovered_at
        });

        return res.status(200).json({
          ok: true,
          ordonnanceId: data[0].id,
          recoveredAt: data[0].recovered_at
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
