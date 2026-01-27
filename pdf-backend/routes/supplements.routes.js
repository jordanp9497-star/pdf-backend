/**
 * Routes pour la gestion des compléments alimentaires
 * 
 * GET /supplements?profile_id=... - Liste des compléments (tri: actifs d'abord, puis created_at desc)
 * POST /supplements - Crée un complément (owner_user_id = user courant)
 * PATCH /supplements/:id - Modifie un complément (title/notes/status/start_date/end_date/schedule)
 * DELETE /supplements/:id - Supprime un complément
 */

import express from 'express';
import { authenticateSupabase } from '../middlewares/auth.js';
import { supabaseAdmin } from '../src/lib/supabaseAdmin.js';

const router = express.Router();

// Utiliser le client Supabase admin centralisé
const supabase = supabaseAdmin;

/**
 * Valide le format du schedule
 * 
 * @param {Object} schedule - Objet schedule à valider
 * @returns {{ valid: boolean, error?: string }}
 */
function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') {
    return { valid: false, error: 'Le schedule doit être un objet' };
  }

  // Vérifier que times existe et n'est pas vide
  if (!schedule.times || !Array.isArray(schedule.times) || schedule.times.length === 0) {
    return { valid: false, error: 'Le schedule.times doit être un tableau non vide' };
  }

  // Vérifier que chaque time est une string valide (format HH:mm)
  for (const time of schedule.times) {
    if (typeof time !== 'string' || !/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
      return { valid: false, error: 'Chaque time doit être au format HH:mm (ex: "08:00")' };
    }
  }

  // Vérifier que mode existe et est connu
  const validModes = ['daily', 'weekly', 'monthly'];
  if (!schedule.mode || !validModes.includes(schedule.mode)) {
    return { valid: false, error: `Le schedule.mode doit être l'un de: ${validModes.join(', ')}` };
  }

  // Si mode = weekly, vérifier daysOfWeek
  if (schedule.mode === 'weekly') {
    if (!schedule.daysOfWeek || !Array.isArray(schedule.daysOfWeek) || schedule.daysOfWeek.length === 0) {
      return { valid: false, error: 'Le schedule.daysOfWeek est requis pour mode=weekly et doit être un tableau non vide' };
    }
    // Vérifier que chaque jour est entre 0 (dimanche) et 6 (samedi)
    for (const day of schedule.daysOfWeek) {
      if (typeof day !== 'number' || day < 0 || day > 6) {
        return { valid: false, error: 'Chaque dayOfWeek doit être un nombre entre 0 (dimanche) et 6 (samedi)' };
      }
    }
  }

  // Si mode = monthly, vérifier dayOfMonth
  if (schedule.mode === 'monthly') {
    if (schedule.dayOfMonth === undefined || schedule.dayOfMonth === null) {
      return { valid: false, error: 'Le schedule.dayOfMonth est requis pour mode=monthly' };
    }
    if (typeof schedule.dayOfMonth !== 'number' || schedule.dayOfMonth < 1 || schedule.dayOfMonth > 31) {
      return { valid: false, error: 'Le schedule.dayOfMonth doit être un nombre entre 1 et 31' };
    }
  }

  return { valid: true };
}

/**
 * GET /supplements?profile_id=...
 * 
 * Liste les compléments de l'utilisateur
 * - Requiert authentification (Bearer token Supabase)
 * - Filtre par owner_user_id = user.id (sécurité)
 * - Optionnel: filtre par profile_id si fourni
 * - Tri: actifs d'abord (status='active'), puis created_at desc
 * 
 * Query params:
 *   - profile_id (optionnel): UUID du profil
 * 
 * Retourne: { ok: true, supplements: [...] }
 */
router.get('/',
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

      const profileId = req.query.profile_id;

      console.log('[SUPPLEMENTS] GET /supplements', {
        userId,
        profileId: profileId || null
      });

      // Vérifier que Supabase est configuré
      if (!supabase) {
        console.error('[SUPPLEMENTS] ❌ Supabase admin client non initialisé');
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la récupération des compléments'
        });
      }

      try {
        // Construire la requête avec filtre owner_user_id (sécurité)
        let query = supabase
          .from('supplements')
          .select('*')
          .eq('owner_user_id', userId);

        // Ajouter filtre profile_id si fourni
        if (profileId) {
          if (typeof profileId !== 'string' || profileId.trim() === '') {
            return res.status(400).json({
              ok: false,
              error: 'BAD_REQUEST',
              message: 'Le paramètre profile_id doit être un UUID valide'
            });
          }
          query = query.eq('profile_id', profileId);
        }

        // Exécuter la requête
        const { data: supplements, error } = await query;

        if (error) {
          console.error('[SUPPLEMENTS] Error fetching supplements:', {
            userId,
            profileId,
            errorCode: error.code,
            errorMessage: error.message
          });

          // Vérifier si c'est une erreur de table manquante
          if (error.code === '42P01' || 
              error.message?.toLowerCase().includes('relation') ||
              error.message?.toLowerCase().includes('does not exist')) {
            return res.status(500).json({
              ok: false,
              error: 'SUPPLEMENTS_TABLE_MISSING',
              message: 'La table supplements n\'existe pas dans la base de données'
            });
          }

          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la récupération des compléments'
          });
        }

        // Trier: actifs d'abord, puis created_at desc
        const sorted = (supplements || []).sort((a, b) => {
          // Actifs en premier
          if (a.status === 'active' && b.status !== 'active') return -1;
          if (a.status !== 'active' && b.status === 'active') return 1;
          
          // Puis tri par created_at desc
          const dateA = new Date(a.created_at || 0);
          const dateB = new Date(b.created_at || 0);
          return dateB - dateA;
        });

        console.log(`[SUPPLEMENTS] ✅ ${sorted.length} complément(s) récupéré(s)`);

        return res.status(200).json({
          ok: true,
          supplements: sorted
        });

      } catch (dbError) {
        console.error('[SUPPLEMENTS] Error fetching supplements:', {
          userId,
          profileId,
          errorMessage: dbError?.message
        });

        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la récupération des compléments'
        });
      }

    } catch (error) {
      console.error('[SUPPLEMENTS] ❌ Erreur inattendue:', error);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de la récupération des compléments'
      });
    }
  }
);

/**
 * POST /supplements
 * 
 * Crée un nouveau complément
 * - Requiert authentification (Bearer token Supabase)
 * - Définit automatiquement owner_user_id = user.id (sécurité)
 * - Valide le schedule si fourni
 * 
 * Body: {
 *   title: string (requis),
 *   notes?: string,
 *   status?: 'active' | 'inactive' (défaut: 'active'),
 *   start_date?: string (ISO date),
 *   end_date?: string (ISO date),
 *   schedule?: { mode, times, daysOfWeek?, dayOfMonth? },
 *   profile_id?: UUID
 * }
 * 
 * Retourne: { ok: true, supplement: {...} }
 */
router.post('/',
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

      const { title, notes, status, start_date, end_date, schedule, profile_id } = req.body;

      // Valider title (requis)
      if (!title || typeof title !== 'string' || title.trim() === '') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Le champ "title" est requis et doit être une string non vide'
        });
      }

      // Valider status si fourni
      if (status !== undefined && status !== 'active' && status !== 'inactive') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Le champ "status" doit être "active" ou "inactive"'
        });
      }

      // Valider les dates si fournies
      if (start_date) {
        const startDate = new Date(start_date);
        if (isNaN(startDate.getTime())) {
          return res.status(400).json({
            ok: false,
            error: 'BAD_REQUEST',
            message: 'Le champ "start_date" doit être une date ISO valide'
          });
        }
      }

      if (end_date) {
        const endDate = new Date(end_date);
        if (isNaN(endDate.getTime())) {
          return res.status(400).json({
            ok: false,
            error: 'BAD_REQUEST',
            message: 'Le champ "end_date" doit être une date ISO valide'
          });
        }
      }

      // Valider schedule si fourni
      if (schedule) {
        const scheduleValidation = validateSchedule(schedule);
        if (!scheduleValidation.valid) {
          return res.status(400).json({
            ok: false,
            error: 'BAD_REQUEST',
            message: scheduleValidation.error
          });
        }
      }

      console.log('[SUPPLEMENTS] POST /supplements', {
        userId,
        title,
        hasSchedule: !!schedule
      });

      // Vérifier que Supabase est configuré
      if (!supabase) {
        console.error('[SUPPLEMENTS] ❌ Supabase admin client non initialisé');
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la création du complément'
        });
      }

      try {
        const now = new Date().toISOString();

        // Construire l'objet à insérer
        const insertData = {
          owner_user_id: userId, // Toujours défini par le serveur (sécurité)
          title: title.trim(),
          notes: notes || null,
          status: status || 'active',
          start_date: start_date || null,
          end_date: end_date || null,
          schedule: schedule || null,
          profile_id: profile_id || null,
          created_at: now,
          updated_at: now
        };

        const { data: supplement, error } = await supabase
          .from('supplements')
          .insert(insertData)
          .select()
          .single();

        if (error) {
          console.error('[SUPPLEMENTS] Error creating supplement:', {
            userId,
            errorCode: error.code,
            errorMessage: error.message
          });

          // Vérifier si c'est une erreur de table manquante
          if (error.code === '42P01' || 
              error.message?.toLowerCase().includes('relation') ||
              error.message?.toLowerCase().includes('does not exist')) {
            return res.status(500).json({
              ok: false,
              error: 'SUPPLEMENTS_TABLE_MISSING',
              message: 'La table supplements n\'existe pas dans la base de données'
            });
          }

          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la création du complément'
          });
        }

        console.log(`[SUPPLEMENTS] ✅ Complément créé: ${supplement.id}`);

        return res.status(201).json({
          ok: true,
          supplement
        });

      } catch (dbError) {
        console.error('[SUPPLEMENTS] Error creating supplement:', {
          userId,
          errorMessage: dbError?.message
        });

        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la création du complément'
        });
      }

    } catch (error) {
      console.error('[SUPPLEMENTS] ❌ Erreur inattendue:', error);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de la création du complément'
      });
    }
  }
);

/**
 * PATCH /supplements/:id
 * 
 * Modifie un complément existant
 * - Requiert authentification (Bearer token Supabase)
 * - Vérifie que owner_user_id = user.id (sécurité)
 * - Valide le schedule si fourni
 * 
 * Body (tous optionnels): {
 *   title?: string,
 *   notes?: string,
 *   status?: 'active' | 'inactive',
 *   start_date?: string (ISO date),
 *   end_date?: string (ISO date),
 *   schedule?: { mode, times, daysOfWeek?, dayOfMonth? }
 * }
 * 
 * Retourne: { ok: true, supplement: {...} }
 */
router.patch('/:id',
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

      // Valider req.params.id
      const supplementId = req.params.id;
      if (!supplementId || typeof supplementId !== 'string' || supplementId.trim() === '') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'ID de complément invalide'
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

      const { title, notes, status, start_date, end_date, schedule } = req.body;

      // Vérifier qu'au moins un champ est fourni
      const hasUpdates = title !== undefined || notes !== undefined || status !== undefined ||
                         start_date !== undefined || end_date !== undefined || schedule !== undefined;
      
      if (!hasUpdates) {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Au moins un champ doit être fourni pour la mise à jour'
        });
      }

      // Valider title si fourni
      if (title !== undefined) {
        if (typeof title !== 'string' || title.trim() === '') {
          return res.status(400).json({
            ok: false,
            error: 'BAD_REQUEST',
            message: 'Le champ "title" doit être une string non vide'
          });
        }
      }

      // Valider status si fourni
      if (status !== undefined && status !== 'active' && status !== 'inactive') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Le champ "status" doit être "active" ou "inactive"'
        });
      }

      // Valider les dates si fournies
      if (start_date !== undefined) {
        if (start_date === null) {
          // Permettre de mettre à null
        } else {
          const startDate = new Date(start_date);
          if (isNaN(startDate.getTime())) {
            return res.status(400).json({
              ok: false,
              error: 'BAD_REQUEST',
              message: 'Le champ "start_date" doit être une date ISO valide ou null'
            });
          }
        }
      }

      if (end_date !== undefined) {
        if (end_date === null) {
          // Permettre de mettre à null
        } else {
          const endDate = new Date(end_date);
          if (isNaN(endDate.getTime())) {
            return res.status(400).json({
              ok: false,
              error: 'BAD_REQUEST',
              message: 'Le champ "end_date" doit être une date ISO valide ou null'
            });
          }
        }
      }

      // Valider schedule si fourni
      if (schedule !== undefined) {
        if (schedule === null) {
          // Permettre de mettre à null
        } else {
          const scheduleValidation = validateSchedule(schedule);
          if (!scheduleValidation.valid) {
            return res.status(400).json({
              ok: false,
              error: 'BAD_REQUEST',
              message: scheduleValidation.error
            });
          }
        }
      }

      console.log('[SUPPLEMENTS] PATCH /supplements/:id', {
        supplementId,
        userId,
        updates: Object.keys(req.body)
      });

      // Vérifier que Supabase est configuré
      if (!supabase) {
        console.error('[SUPPLEMENTS] ❌ Supabase admin client non initialisé');
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la mise à jour du complément'
        });
      }

      try {
        // 1. Vérifier que le complément existe et appartient à l'utilisateur
        const { data: existingSupplement, error: checkError } = await supabase
          .from('supplements')
          .select('id, owner_user_id')
          .eq('id', supplementId)
          .eq('owner_user_id', userId)
          .maybeSingle();

        if (checkError) {
          console.error('[SUPPLEMENTS] Error checking supplement:', {
            supplementId,
            userId,
            errorCode: checkError.code,
            errorMessage: checkError.message
          });

          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la vérification du complément'
          });
        }

        if (!existingSupplement) {
          return res.status(404).json({
            ok: false,
            error: 'NOT_FOUND',
            message: 'Complément non trouvé'
          });
        }

        // 2. Construire l'objet de mise à jour
        const updateData = {
          updated_at: new Date().toISOString()
        };

        if (title !== undefined) updateData.title = title.trim();
        if (notes !== undefined) updateData.notes = notes || null;
        if (status !== undefined) updateData.status = status;
        if (start_date !== undefined) updateData.start_date = start_date;
        if (end_date !== undefined) updateData.end_date = end_date;
        if (schedule !== undefined) updateData.schedule = schedule;

        // 3. Mettre à jour le complément
        const { data: supplement, error: updateError } = await supabase
          .from('supplements')
          .update(updateData)
          .eq('id', supplementId)
          .eq('owner_user_id', userId) // Double sécurité
          .select()
          .single();

        if (updateError) {
          console.error('[SUPPLEMENTS] Error updating supplement:', {
            supplementId,
            userId,
            errorCode: updateError.code,
            errorMessage: updateError.message
          });

          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la mise à jour du complément'
          });
        }

        console.log(`[SUPPLEMENTS] ✅ Complément mis à jour: ${supplement.id}`);

        return res.status(200).json({
          ok: true,
          supplement
        });

      } catch (dbError) {
        console.error('[SUPPLEMENTS] Error updating supplement:', {
          supplementId,
          userId,
          errorMessage: dbError?.message
        });

        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la mise à jour du complément'
        });
      }

    } catch (error) {
      console.error('[SUPPLEMENTS] ❌ Erreur inattendue:', error);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de la mise à jour du complément'
      });
    }
  }
);

/**
 * DELETE /supplements/:id
 * 
 * Supprime un complément
 * - Requiert authentification (Bearer token Supabase)
 * - Vérifie que owner_user_id = user.id (sécurité)
 * 
 * Retourne: { ok: true }
 */
router.delete('/:id',
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

      // Valider req.params.id
      const supplementId = req.params.id;
      if (!supplementId || typeof supplementId !== 'string' || supplementId.trim() === '') {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'ID de complément invalide'
        });
      }

      console.log('[SUPPLEMENTS] DELETE /supplements/:id', {
        supplementId,
        userId
      });

      // Vérifier que Supabase est configuré
      if (!supabase) {
        console.error('[SUPPLEMENTS] ❌ Supabase admin client non initialisé');
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la suppression du complément'
        });
      }

      try {
        // 1. Vérifier que le complément existe et appartient à l'utilisateur
        const { data: existingSupplement, error: checkError } = await supabase
          .from('supplements')
          .select('id, owner_user_id')
          .eq('id', supplementId)
          .eq('owner_user_id', userId)
          .maybeSingle();

        if (checkError) {
          console.error('[SUPPLEMENTS] Error checking supplement:', {
            supplementId,
            userId,
            errorCode: checkError.code,
            errorMessage: checkError.message
          });

          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la vérification du complément'
          });
        }

        if (!existingSupplement) {
          return res.status(404).json({
            ok: false,
            error: 'NOT_FOUND',
            message: 'Complément non trouvé'
          });
        }

        // 2. Supprimer le complément
        const { error: deleteError } = await supabase
          .from('supplements')
          .delete()
          .eq('id', supplementId)
          .eq('owner_user_id', userId); // Double sécurité

        if (deleteError) {
          console.error('[SUPPLEMENTS] Error deleting supplement:', {
            supplementId,
            userId,
            errorCode: deleteError.code,
            errorMessage: deleteError.message
          });

          return res.status(500).json({
            ok: false,
            error: 'DATABASE_ERROR',
            message: 'Erreur lors de la suppression du complément'
          });
        }

        console.log(`[SUPPLEMENTS] ✅ Complément supprimé: ${supplementId}`);

        return res.status(200).json({
          ok: true
        });

      } catch (dbError) {
        console.error('[SUPPLEMENTS] Error deleting supplement:', {
          supplementId,
          userId,
          errorMessage: dbError?.message
        });

        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la suppression du complément'
        });
      }

    } catch (error) {
      console.error('[SUPPLEMENTS] ❌ Erreur inattendue:', error);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de la suppression du complément'
      });
    }
  }
);

export default router;
