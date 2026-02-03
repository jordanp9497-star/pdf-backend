/**
 * Routes pour la gestion des appareils
 *
 * POST /devices/heartbeat - Enregistrer/mettre à jour un appareil
 */

import express from 'express';
import type { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { authenticateSupabase } from '../middlewares/auth.js';
import { supabaseAdmin } from '../src/lib/supabaseAdmin.js';
import { SUPABASE_CONFIG } from '../src/config/env.js';

const router = express.Router();

/**
 * Crée un client Supabase avec le token utilisateur (pour RLS)
 * Fallback vers service_role si le token n'est pas disponible
 */
function getSupabaseClient(req: Request) {
  const authHeader = req.headers.authorization;

  // Essayer d'utiliser le client user (RLS) si un token est présent
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    if (token && SUPABASE_CONFIG.url && process.env.SUPABASE_ANON_KEY) {
      try {
        // Créer un client avec anon key et passer le token dans les headers
        const userClient = createClient(SUPABASE_CONFIG.url, process.env.SUPABASE_ANON_KEY, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
          },
          global: {
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        });

        return userClient;
      } catch (error: any) {
        console.warn('[DEVICES] Erreur création client user, fallback service_role:', error.message);
      }
    }
  }

  // Fallback: utiliser service_role
  return supabaseAdmin;
}

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

      // Obtenir le client Supabase (user si possible, sinon service_role)
      const supabase = getSupabaseClient(req);

      // Vérifier que Supabase est configuré
      if (!supabase) {
        console.error('[DEVICES] ❌ Supabase client non initialisé');
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de l\'enregistrement de l\'appareil'
        });
      }

      try {
        // Upsert l'appareil (match sur user_id, device_id)
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
          // Logger l'erreur Supabase complète
          console.error('[DEVICES] Error upserting device - Supabase error complete:', {
            userId,
            deviceId,
            errorCode: upsertError.code,
            errorMessage: upsertError.message,
            errorDetails: upsertError.details,
            errorHint: upsertError.hint
          });

          // Vérifier si c'est une erreur de table manquante
          if (upsertError.code === '42P01' || // relation does not exist
              upsertError.message?.toLowerCase().includes('relation') ||
              upsertError.message?.toLowerCase().includes('does not exist') ||
              upsertError.message?.toLowerCase().includes('table') && upsertError.message?.toLowerCase().includes('not found')) {
            console.error('[DEVICES] ❌ Table devices n\'existe pas');
            return res.status(500).json({
              ok: false,
              error: 'DEVICES_TABLE_MISSING',
              message: 'La table devices n\'existe pas dans la base de données'
            });
          }

          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de l\'enregistrement de l\'appareil'
          });
        }

        // Compter les appareils actifs de l'utilisateur (last_seen_at >= 7 jours)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const { count, error: countError } = await supabase
          .from('devices')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId)
          .gte('last_seen_at', sevenDaysAgo.toISOString());

        if (countError) {
          // Logger l'erreur Supabase complète
          console.error('[DEVICES] Error counting devices - Supabase error complete:', {
            userId,
            errorCode: countError.code,
            errorMessage: countError.message,
            errorDetails: countError.details,
            errorHint: countError.hint
          });

          // Vérifier si c'est une erreur de table manquante
          if (countError.code === '42P01' ||
              countError.message?.toLowerCase().includes('relation') ||
              countError.message?.toLowerCase().includes('does not exist')) {
            console.error('[DEVICES] ❌ Table devices n\'existe pas');
            return res.status(500).json({
              ok: false,
              error: 'DEVICES_TABLE_MISSING',
              message: 'La table devices n\'existe pas dans la base de données'
            });
          }

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

      } catch (dbError: any) {
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
