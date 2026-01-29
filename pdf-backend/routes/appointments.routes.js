/**
 * Routes rendez-vous – table public.appointments
 *
 * POST /api/appointments – créer un RDV lié à une prescription
 */

import express from 'express';
import { authenticateSupabase } from '../middlewares/auth.js';
import { supabaseAdmin } from '../src/lib/supabaseAdmin.js';

const router = express.Router();
const supabase = supabaseAdmin;

function getUserId(req) {
  return req.userId || req.user?.id;
}

/**
 * POST /api/appointments
 *
 * Body: { prescription_id, starts_at, title?, location?, notes? }
 * - Charge la prescription et vérifie owner_user_id/user_id = auth user
 * - Crée appointment (user_id, profile_id, linked_prescription_id, starts_at, title, location, notes)
 * - Optionnel: update prescription (document_kind='rdv', status='ready', needs_review=false)
 * Retourne: { ok: true, appointment }
 */
router.post('/', authenticateSupabase, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise',
      });
    }

    const body = req.body || {};
    const prescriptionId = typeof body.prescription_id === 'string' ? body.prescription_id.trim() : '';
    const startsAt = body.starts_at;
    const title = body.title != null ? String(body.title).trim() || null : null;
    const location = body.location != null ? String(body.location).trim() || null : null;
    const notes = body.notes != null ? String(body.notes).trim() || null : null;

    if (!prescriptionId) {
      return res.status(400).json({
        ok: false,
        error: 'BAD_REQUEST',
        message: 'prescription_id est requis',
      });
    }

    const startsAtDate = startsAt != null ? new Date(startsAt) : null;
    if (!startsAt || isNaN(startsAtDate.getTime())) {
      return res.status(400).json({
        ok: false,
        error: 'BAD_REQUEST',
        message: 'starts_at doit être une date valide (ISO ou timestamp)',
      });
    }

    const { data: prescription, error: prescError } = await supabase
      .from('prescriptions')
      .select('id, profile_id, user_id, owner_user_id')
      .eq('id', prescriptionId)
      .or(`owner_user_id.eq.${userId},user_id.eq.${userId}`)
      .maybeSingle();

    if (prescError) {
      console.error('[APPOINTMENTS] load prescription:', prescError);
      return res.status(500).json({
        ok: false,
        error: 'DATABASE_ERROR',
        message: 'Erreur lors de la récupération de la prescription',
      });
    }

    if (!prescription) {
      return res.status(404).json({
        ok: false,
        error: 'NOT_FOUND',
        message: 'Prescription introuvable ou accès refusé',
      });
    }

    const profileId = prescription.profile_id ?? null;

    const { data: appointment, error: insertError } = await supabase
      .from('appointments')
      .insert({
        user_id: userId,
        profile_id: profileId,
        linked_prescription_id: prescription.id,
        starts_at: startsAtDate.toISOString(),
        title,
        location,
        notes,
      })
      .select()
      .single();

    if (insertError) {
      console.error('[APPOINTMENTS] create:', insertError);
      return res.status(500).json({
        ok: false,
        error: 'DATABASE_ERROR',
        message: insertError.message ?? 'Erreur lors de la création du rendez-vous',
      });
    }

    await supabase
      .from('prescriptions')
      .update({
        document_kind: 'rdv',
        status: 'ready',
        needs_review: false,
      })
      .eq('id', prescriptionId);

    return res.status(201).json({
      ok: true,
      appointment,
    });
  } catch (err) {
    console.error('[APPOINTMENTS] POST / error:', err);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Erreur serveur',
    });
  }
});

export default router;
