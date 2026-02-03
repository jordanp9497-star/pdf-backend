/**
 * Routes pour la gestion des traitements
 *
 * GET /treatments/active - Récupérer les traitements actifs
 */

import express from 'express';
import type { Request, Response } from 'express';
import { authenticateSupabase } from '../middlewares/auth.js';

const router = express.Router();

/**
 * GET /treatments/active
 *
 * Récupère les traitements actifs de l'utilisateur
 * - Requiert authentification (Bearer token Supabase)
 * - Stub: retourne un tableau vide pour l'instant
 *
 * Retourne: { ok: true, treatments: [] }
 */
router.get('/active',
  authenticateSupabase,
  async (req: Request, res: Response) => {
    try {
      // Vérifier que l'utilisateur est authentifié
      const userId = (req as any).userId || (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'Authentification requise'
        });
      }

      console.log('[TREATMENTS] GET /treatments/active', {
        userId
      });

      // Stub: retourner un tableau vide pour l'instant
      return res.status(200).json({
        ok: true,
        treatments: []
      });

    } catch (error) {
      console.error('[TREATMENTS] ❌ Erreur inattendue:', error);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de la récupération des traitements'
      });
    }
  }
);

export default router;
