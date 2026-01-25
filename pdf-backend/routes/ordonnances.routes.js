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

      const userId = req.user.id;

      console.log('[ORDONNANCES] POST /ordonnances/:id/recovered', {
        ordonnanceId,
        userId,
        recoveredAt
      });

      // Mettre à jour dans Supabase si disponible
      if (supabase) {
        try {
          const { data, error } = await supabase
            .from('ordonnances')
            .update({
              recovered_at: recoveredAt,
              updated_at: new Date().toISOString()
            })
            .eq('id', ordonnanceId)
            .eq('user_id', userId) // Sécurité: s'assurer que l'ordonnance appartient à l'utilisateur
            .select('id, recovered_at')
            .single();

          if (error) {
            // Si l'erreur est "PGRST116" (no rows returned), l'ordonnance n'existe pas ou n'appartient pas à l'utilisateur
            if (error.code === 'PGRST116' || error.message?.includes('No rows')) {
              console.log(`[ORDONNANCES] ❌ Ordonnance ${ordonnanceId} non trouvée ou n'appartient pas à l'utilisateur ${userId}`);
              return res.status(404).json({
                ok: false,
                error: 'NOT_FOUND',
                message: 'Ordonnance non trouvée ou vous n\'avez pas les permissions'
              });
            }

            console.error('[ORDONNANCES] ❌ Erreur lors de la mise à jour:', error);
            return res.status(500).json({
              ok: false,
              error: 'DATABASE_ERROR',
              message: 'Erreur lors de la mise à jour de l\'ordonnance'
            });
          }

          if (!data) {
            return res.status(404).json({
              ok: false,
              error: 'NOT_FOUND',
              message: 'Ordonnance non trouvée'
            });
          }

          console.log(`[ORDONNANCES] ✅ Ordonnance ${ordonnanceId} marquée comme récupérée`);

          return res.status(200).json({
            ok: true,
            ordonnanceId: data.id,
            recoveredAt: data.recovered_at
          });

        } catch (dbError) {
          console.error('[ORDONNANCES] ❌ Erreur base de données:', dbError);
          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la mise à jour de l\'ordonnance'
          });
        }
      } else {
        // Fallback: Supabase non configuré (MVP sans persistance)
        console.warn('[ORDONNANCES] ⚠️ TODO: Supabase non configuré, réponse OK sans persistance');
        console.warn('[ORDONNANCES] ⚠️ TODO: Implémenter la persistance dans la table ordonnances');
        
        return res.status(200).json({
          ok: true,
          ordonnanceId: ordonnanceId,
          recoveredAt: recoveredAt,
          _warning: 'TODO: Persistance non implémentée (Supabase non configuré)'
        });
      }

    } catch (error) {
      console.error('[ORDONNANCES] ❌ Erreur inattendue:', error);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de la mise à jour de l\'ordonnance'
      });
    }
  }
);

export default router;
