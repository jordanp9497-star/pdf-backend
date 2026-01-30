/**
 * Routes CRUD enfants – table public.children (owner_user_id = auth user)
 *
 * GET    /api/children       – liste enfants
 * POST   /api/children       – create (first_name, birth_date, sex, notes, health_json)
 * GET    /api/children/:id   – get single (vérifier owner)
 * PATCH  /api/children/:id   – update (mêmes champs)
 * DELETE /api/children/:id   – delete
 */

import express from 'express';
import { authenticateSupabase } from '../middlewares/auth.js';
import { supabaseAdmin } from '../src/lib/supabaseAdmin.js';

const router = express.Router();
const supabase = supabaseAdmin;

const SEX_VALUES = ['M', 'F', 'X'];

function getUserId(req) {
  return req.userId || req.user?.id;
}

function json400(res, message) {
  return res.status(400).json({ ok: false, error: 'BAD_REQUEST', message });
}

/**
 * Valide le body create/update: first_name non vide, sex ∈ M/F/X si fourni.
 */
function validateChildBody(body, isCreate) {
  if (!body || typeof body !== 'object') return { error: 'Body JSON attendu' };
  const first_name = body.first_name != null ? String(body.first_name).trim() : '';
  if (isCreate && !first_name) return { error: 'first_name est requis et ne doit pas être vide' };
  if (!isCreate && body.first_name !== undefined && !first_name) return { error: 'first_name ne doit pas être vide' };
  if (body.sex != null && body.sex !== '') {
    const s = String(body.sex).toUpperCase();
    if (!SEX_VALUES.includes(s)) return { error: `sex doit être l'un de: ${SEX_VALUES.join(', ')}` };
  }
  return { first_name: first_name || undefined, sex: body.sex, birth_date: body.birth_date, notes: body.notes, health_json: body.health_json };
}

/**
 * GET /api/children – Liste des enfants (owner_user_id = auth user)
 */
router.get('/', authenticateSupabase, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Authentification requise' });
    }
    if (!supabase) {
      return res.status(500).json({ ok: false, error: 'DATABASE_ERROR', message: 'Erreur base de données' });
    }
    const { data, error } = await supabase
      .from('children')
      .select('*')
      .eq('owner_user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[CHILDREN] list error:', error);
      return res.status(500).json({ ok: false, error: 'DATABASE_ERROR', message: 'Erreur lors de la récupération' });
    }
    return res.status(200).json({ ok: true, children: data ?? [] });
  } catch (err) {
    console.error('[CHILDREN] GET / error:', err);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: 'Erreur serveur' });
  }
});

/**
 * POST /api/children – Créer un enfant
 */
router.post('/', authenticateSupabase, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Authentification requise' });
    }
    const validation = validateChildBody(req.body || {}, true);
    if (validation.error) return json400(res, validation.error);

    const row = {
      owner_user_id: userId,
      first_name: validation.first_name,
      birth_date: validation.birth_date ?? null,
      sex: validation.sex != null && validation.sex !== '' ? String(validation.sex).toUpperCase() : null,
      notes: validation.notes ?? null,
      health_json: validation.health_json ?? null,
    };

    const { data, error } = await supabase.from('children').insert(row).select().single();
    if (error) {
      console.error('[CHILDREN] create error:', error);
      return res.status(500).json({ ok: false, error: 'DATABASE_ERROR', message: 'Erreur lors de la création' });
    }
    return res.status(201).json({ ok: true, child: data });
  } catch (err) {
    console.error('[CHILDREN] POST / error:', err);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: 'Erreur serveur' });
  }
});

/**
 * GET /api/children/:id – Détail d'un enfant (vérifier owner)
 */
router.get('/:id', authenticateSupabase, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Authentification requise' });
    }
    const id = req.params.id?.trim();
    if (!id) return json400(res, 'ID requis');

    const { data, error } = await supabase
      .from('children')
      .select('*')
      .eq('id', id)
      .eq('owner_user_id', userId)
      .maybeSingle();

    if (error) {
      console.error('[CHILDREN] get by id error:', error);
      return res.status(500).json({ ok: false, error: 'DATABASE_ERROR', message: 'Erreur lors de la récupération' });
    }
    if (!data) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Enfant introuvable' });
    }
    return res.status(200).json({ ok: true, child: data });
  } catch (err) {
    console.error('[CHILDREN] GET /:id error:', err);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: 'Erreur serveur' });
  }
});

/**
 * PATCH /api/children/:id – Mise à jour (first_name, birth_date, sex, notes, health_json)
 */
router.patch('/:id', authenticateSupabase, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Authentification requise' });
    }
    const id = req.params.id?.trim();
    if (!id) return json400(res, 'ID requis');

    const validation = validateChildBody(req.body || {}, false);
    if (validation.error) return json400(res, validation.error);

    const update = {};
    if (validation.first_name !== undefined) update.first_name = validation.first_name;
    if (validation.birth_date !== undefined) update.birth_date = validation.birth_date ?? null;
    if (validation.sex !== undefined) update.sex = validation.sex != null && validation.sex !== '' ? String(validation.sex).toUpperCase() : null;
    if (validation.notes !== undefined) update.notes = validation.notes ?? null;
    if (validation.health_json !== undefined) update.health_json = validation.health_json ?? null;

    if (Object.keys(update).length === 0) {
      const { data: existing } = await supabase.from('children').select('*').eq('id', id).eq('owner_user_id', userId).maybeSingle();
      if (!existing) return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Enfant introuvable' });
      return res.status(200).json({ ok: true, child: existing });
    }

    const { data, error } = await supabase
      .from('children')
      .update(update)
      .eq('id', id)
      .eq('owner_user_id', userId)
      .select()
      .single();

    if (error) {
      console.error('[CHILDREN] patch error:', error);
      return res.status(500).json({ ok: false, error: 'DATABASE_ERROR', message: 'Erreur lors de la mise à jour' });
    }
    if (!data) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Enfant introuvable' });
    }
    return res.status(200).json({ ok: true, child: data });
  } catch (err) {
    console.error('[CHILDREN] PATCH /:id error:', err);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: 'Erreur serveur' });
  }
});

/**
 * DELETE /api/children/:id – Supprimer un enfant (vérifier owner)
 */
router.delete('/:id', authenticateSupabase, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Authentification requise' });
    }
    const id = req.params.id?.trim();
    if (!id) return json400(res, 'ID requis');

    const { data, error } = await supabase
      .from('children')
      .delete()
      .eq('id', id)
      .eq('owner_user_id', userId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[CHILDREN] delete error:', error);
      return res.status(500).json({ ok: false, error: 'DATABASE_ERROR', message: 'Erreur lors de la suppression' });
    }
    if (!data) {
      return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Enfant introuvable' });
    }
    return res.status(200).json({ ok: true, deleted: true, id: data.id });
  } catch (err) {
    console.error('[CHILDREN] DELETE /:id error:', err);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: 'Erreur serveur' });
  }
});

export default router;
