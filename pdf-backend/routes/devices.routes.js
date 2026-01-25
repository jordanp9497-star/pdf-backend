/**
 * Routes pour la gestion des appareils
 * 
 * POST /devices/heartbeat - Enregistrer/mettre à jour un appareil
 */

import express from 'express';
import { authenticateSupabase } from '../middlewares/auth.js';
import { supabaseAdmin } from '../src/lib/supabaseAdmin.js';

const router = express.Router();

// Utiliser le client Supabase admin centralisé
const supabase = supabaseAdmin;

/**
 * POST /devices/heartbeat
 * 
 * Enregistre ou met à jour un appareil
 * - Requiert authentification (Bearer token Supabase)
 * - Upsert dans public.devices avec last_seen_at
 * - Retourne le nombre d'appareils actifs de l'utilisateur
 * 
 * Body: { 
 *   deviceId: string,
 *   platform: string (ex: "ios", "android"),
 *   model: string (ex: "iPhone 14 Pro"),
 *   appVersion: string (ex: "1.0.0")
 * }
 * Retourne: { ok: true, deviceCount: number }
 */
router.post('/heartbeat',
  authenticateSupabase,
  async (req, res) => {
    try {
      // Vérifier que l'utilisateur est authentifié
      const userId = req.userId || req.user?.id;
      if (!userId) {
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

      const { deviceId, platform, model, appVersion } = req.body;

      // Valider deviceId
      if (!deviceId || typeof deviceId !== 'string' || deviceId.trim() === '') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Le champ "deviceId" est requis'
        });
      }

      // Valider platform
      if (!platform || typeof platform !== 'string' || platform.trim() === '') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Le champ "platform" est requis'
        });
      }

      console.log('[DEVICES] POST /devices/heartbeat', {
        userId,
        deviceId,
        platform,
        model: model || 'N/A',
        appVersion: appVersion || 'N/A'
      });

      // Vérifier que Supabase est configuré
      if (!supabase) {
        console.error('[DEVICES] ❌ Supabase admin client non initialisé');
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de l\'enregistrement de l\'appareil'
        });
      }

      try {
        // Upsert l'appareil
        const now = new Date().toISOString();
        const { data: device, error: upsertError } = await supabase
          .from('devices')
          .upsert({
            user_id: userId,
            device_id: deviceId,
            platform: platform.trim(),
            model: model?.trim() || null,
            app_version: appVersion?.trim() || null,
            last_seen_at: now,
            updated_at: now
          }, {
            onConflict: 'user_id,device_id',
            ignoreDuplicates: false
          })
          .select('id')
          .single();

        if (upsertError) {
          console.error('[DEVICES] Error upserting device:', {
            userId,
            deviceId,
            errorMessage: upsertError.message,
            errorDetails: upsertError.details,
            errorHint: upsertError.hint,
            errorCode: upsertError.code
          });

          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de l\'enregistrement de l\'appareil'
          });
        }

        // Compter les appareils actifs de l'utilisateur (last_seen_at < 7 jours)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const { count, error: countError } = await supabase
          .from('devices')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId)
          .gte('last_seen_at', sevenDaysAgo.toISOString());

        if (countError) {
          console.error('[DEVICES] Error counting devices:', countError);
          // Ne pas bloquer la réponse, utiliser 1 comme fallback
          return res.status(200).json({
            ok: true,
            deviceCount: 1
          });
        }

        const deviceCount = count || 0;

        console.log('[DEVICES] ✅ Appareil enregistré', {
          userId,
          deviceId,
          deviceCount
        });

        return res.status(200).json({
          ok: true,
          deviceCount: deviceCount
        });

      } catch (dbError) {
        console.error('[DEVICES] ❌ Erreur inattendue:', {
          userId,
          deviceId,
          errorMessage: dbError?.message,
          errorStack: dbError?.stack
        });

        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de l\'enregistrement de l\'appareil'
        });
      }

    } catch (error) {
      console.error('[DEVICES] ❌ Erreur inattendue:', error);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de l\'enregistrement de l\'appareil'
      });
    }
  }
);

export default router;
