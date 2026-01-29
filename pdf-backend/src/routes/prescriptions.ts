/**
 * Routes prescriptions – import ordonnance PDF
 *
 * Tables Supabase:
 * - prescriptions (user_id, profile_id, status, raw_text, data JSONB)
 * - prescription_files (prescription_id, user_id, profile_id, storage_path NOT NULL, mime_type, size_bytes, meta — pas de bucket/original_name si colonnes incertaines)
 * - prescription_items (prescription_id, user_id, profile_id, idx, label, raw_line, data JSONB — pas de colonnes dosage/duree/etc.)
 *
 * Monté sur /api/prescriptions
 */

import express, { Request, Response } from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import { randomUUID } from 'crypto';
import { requireUser } from '../../middlewares/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import {
  uploadBufferToStorage,
  createSignedUrl,
  isBucketNotFoundError,
  getPrescriptionStoragePathDeterministic,
} from '../services/storageService.js';
import { structurizePrescriptionText } from '../services/prescriptionStructService.js';
import type { PrescriptionStruct } from '../schemas/prescriptionStruct.js';

const router = express.Router();

/**
 * Statuts stricts pour prescriptions (contrainte DB prescriptions_status_check).
 * Seules valeurs autorisées: processing | ready | manual_required | error.
 *
 * Import-pdf:
 * - Création prescription => status = "processing"
 * - Pas de texte exploitable => update status = "manual_required"
 * - Parsing OK => update status = "ready"
 * - Exception => update status = "error"
 *
 * Aucune autre valeur n'est autorisée.
 */
export const PrescriptionStatus = {
  PROCESSING: 'processing',
  READY: 'ready',
  MANUAL_REQUIRED: 'manual_required',
  ERROR: 'error',
} as const;

export type PrescriptionStatusType = (typeof PrescriptionStatus)[keyof typeof PrescriptionStatus];

const PRESCRIPTION_STATUS_VALUES: readonly PrescriptionStatusType[] = Object.values(PrescriptionStatus);

/** Vérifie que la valeur est un statut autorisé ; interdit toute autre valeur. */
export function isPrescriptionStatus(value: unknown): value is PrescriptionStatusType {
  return typeof value === 'string' && PRESCRIPTION_STATUS_VALUES.includes(value as PrescriptionStatusType);
}

const BUCKET = process.env.PRESCRIPTIONS_BUCKET || 'prescriptions';
const UPLOAD_LIMIT = 10 * 1024 * 1024; // 10MB

const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMIT },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/pdf';
    cb(null, ok);
  },
});

/** Multer pour import-pdf : champ "file", 10MB (PDF ou autre pour extension future) */
const uploadImportPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMIT },
});

/**
 * POST /api/prescriptions/import
 *
 * Import d'une ordonnance PDF:
 * - Crée une ligne prescriptions (user_id, raw_text, statut)
 * - Upload du fichier dans le bucket Supabase et ligne prescription_files
 * - Optionnel: items dans le body pour prescription_items
 *
 * Body (multipart): file = PDF
 * Body (JSON après multipart): header?, items?[]
 * Réponse: { ok, prescription: { id, raw_text, statut }, file: { bucket, path }, itemsCount }
 */
router.post(
  '/import',
  requireUser,
  uploadPdf.single('file'),
  async (req: Request, res: Response) => {
    try {
      const userId = (req as Request & { userId?: string }).userId;
      if (!userId) {
        return res.status(401).json({
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'Authentification requise',
        });
      }

      if (!req.file || !req.file.buffer) {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'Fichier PDF requis (field "file")',
        });
      }

      const buffer = req.file.buffer as Buffer;
      const mime = req.file.mimetype || 'application/pdf';
      const size = buffer.length;
      const originalName = req.file.originalname || 'ordonnance.pdf';

      let rawText = '';
      try {
        const parsed = await pdfParse(buffer);
        rawText = parsed.text || '';
      } catch (parseErr) {
        console.error('[PRESCRIPTIONS] pdf-parse error:', parseErr);
        return res.status(400).json({
          ok: false,
          error: 'INVALID_PDF',
          message: 'Impossible d\'extraire le texte du PDF',
        });
      }

      const header = typeof req.body?.header === 'string' ? req.body.header : '';
      const statut = 'imported';
      const prescriptionId = randomUUID();

      const { error: prescError } = await supabaseAdmin.from('prescriptions').insert({
        id: prescriptionId,
        user_id: userId,
        header: header || null,
        raw_text: rawText,
        statut,
      });

      if (prescError) {
        console.error('[PRESCRIPTIONS] insert prescription:', prescError);
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la création de la prescription',
        });
      }

      const bucket = 'prescription-files';
      const path = `${userId}/${prescriptionId}/${originalName}`;

      const { error: uploadError } = await supabaseAdmin.storage.from(bucket).upload(path, buffer, {
        contentType: mime,
        upsert: false,
      });

      if (uploadError) {
        console.error('[PRESCRIPTIONS] storage upload:', uploadError);
        // On ne supprime pas la prescription; on peut réessayer l’upload plus tard
      }

      const { error: fileRowError } = await supabaseAdmin.from('prescription_files').insert({
        prescription_id: prescriptionId,
        bucket,
        path,
        mime,
        size,
      });

      if (fileRowError) {
        console.error('[PRESCRIPTIONS] insert prescription_files:', fileRowError);
      }

      let itemsCount = 0;
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (items.length > 0) {
        const rows = items.slice(0, 200).map((item: Record<string, unknown>) => ({
          prescription_id: prescriptionId,
          ...(typeof item === 'object' && item !== null ? item : {}),
        }));
        const { error: itemsError } = await supabaseAdmin.from('prescription_items').insert(rows);
        if (!itemsError) itemsCount = rows.length;
        else console.error('[PRESCRIPTIONS] insert prescription_items:', itemsError);
      }

      return res.status(201).json({
        ok: true,
        prescription: {
          id: prescriptionId,
          raw_text: rawText.slice(0, 500),
          statut,
        },
        file: { bucket, path },
        itemsCount,
      });
    } catch (err) {
      console.error('[PRESCRIPTIONS] import error:', err);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Erreur lors de l\'import de l\'ordonnance',
      });
    }
  }
);

/**
 * POST /api/prescriptions/import-pdf
 *
 * Entrée: multipart/form-data — file (obligatoire), profile_id ou profileId (body/query, obligatoire).
 * 1) Auth requireUser (req.userId)
 * 2) Upload fichier brut Supabase Storage (bucket prescriptions) via storageService
 * 3) Extraction texte : PDF => pdf-parse ; rawText nettoyé ; si vide ou < 30 chars => status needs_manual, raw_text null ; sinon pending_verification + raw_text
 * 4) Si rawText : OpenAI structuration → JSON validé zod ; fallback header null + items []
 * 5) Insert prescriptions, prescription_files, prescription_items
 * Réponse: 200 { ok, prescriptionId, status, extracted, itemsCount } | 422 NO_TEXT_IN_PDF | 400 MISSING_FILE / MISSING_PROFILE_ID
 */
router.post(
  '/import-pdf',
  requireUser,
  uploadImportPdf.single('file'),
  async (req: Request, res: Response) => {
    const traceId = randomUUID();
    type ReqWithUser = Request & { userId?: string };
    const reqUser = req as ReqWithUser;
    const userId = reqUser.userId;

    console.log('[PRESCRIPTIONS] import-pdf', {
      traceId,
      userId: userId ?? null,
      bodyKeys: Object.keys(req.body || {}),
    });

    if (!userId) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise',
      });
    }

    const rawProfileId = req.body?.profile_id ?? req.body?.profileId ?? req.query?.profile_id;
    const profileId = typeof rawProfileId === 'string' ? rawProfileId.trim() : '';
    if (!profileId) {
      return res.status(400).json({
        ok: false,
        error: 'MISSING_PROFILE_ID',
        message: 'Le champ profile_id est obligatoire',
      });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('id', profileId)
      .eq('owner_user_id', userId)
      .maybeSingle();

    if (profileError) {
      console.error('[PRESCRIPTIONS] import-pdf profile fetch', { traceId, profileId, error: profileError });
      return res.status(500).json({
        ok: false,
        error: 'DB_ERROR',
        message: profileError.message ?? 'Erreur lors de la vérification du profil',
        traceId,
      });
    }

    if (!profile) {
      return res.status(403).json({
        ok: false,
        error: 'PROFILE_FORBIDDEN',
        message: 'Profil introuvable ou vous n\'avez pas accès à ce profil',
        profileId,
        traceId,
      });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        error: 'MISSING_FILE',
        message: 'Le champ fichier "file" est obligatoire',
      });
    }

    console.log('[PRESCRIPTIONS] import-pdf file', {
      traceId,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: (req.file.buffer as Buffer).length,
    });

    const buffer = req.file.buffer as Buffer;
    const contentType = req.file.mimetype || 'application/octet-stream';
    const size = buffer.length;
    const originalNameForDb = normalizeOriginalFilename(req.file.originalname || 'document.pdf');
    const prescriptionId = randomUUID();
    // storagePath calculé AVANT upload, puis réutilisé pour l'insert prescription_files (NOT NULL).
    const storagePath = getPrescriptionStoragePathDeterministic(userId, profileId, prescriptionId, originalNameForDb);
    if (!storagePath || !storagePath.trim()) {
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'storage_path vide',
        traceId,
      });
    }
    const stepStorageUpload = 'storage_upload';
    console.log('[PRESCRIPTIONS] import-pdf step', { traceId, stepName: stepStorageUpload });

    try {
      await uploadBufferToStorage({
        bucket: BUCKET,
        path: storagePath,
        buffer,
        contentType,
      });
    } catch (storageErr: unknown) {
      const err = storageErr as Error & { message?: string; code?: string; statusCode?: number };
      console.error('[PRESCRIPTIONS] import-pdf storage upload failed', { traceId, stepName: stepStorageUpload, error: err });
      if (isBucketNotFoundError(storageErr)) {
        return res.status(500).json({
          ok: false,
          error: 'BUCKET_NOT_FOUND',
          message: 'Le bucket Storage "prescriptions" est introuvable. Créez-le dans le dashboard Supabase ou vérifiez la config.',
          details: err?.message ?? null,
          traceId,
        });
      }
      const details =
        err instanceof Error
          ? { message: err.message, name: err.name, ...(err as Record<string, unknown>) }
          : (storageErr as Record<string, unknown>);
      return res.status(500).json({
        ok: false,
        error: 'STORAGE_UPLOAD_FAILED',
        step: stepStorageUpload,
        message: err?.message ?? 'Upload Storage échoué',
        details,
        traceId,
      });
    }

    type SupabaseErrorLike = { code?: string; message?: string; details?: string; hint?: string };
    const stepPrescriptionsInsert = 'prescriptions_insert';
    console.log('[PRESCRIPTIONS] import-pdf step', { traceId, stepName: stepPrescriptionsInsert });

    // Toujours 'processing' à la création (jamais 'draft' pendant l'import).
    const insertPayload: Record<string, unknown> = {
      id: prescriptionId,
      user_id: userId,
      owner_user_id: userId,
      profile_id: profileId,
      status: PrescriptionStatus.PROCESSING,
      raw_text: null,
      data: {},
    };
    console.log('[PRESCRIPTIONS] import-pdf insert prescriptions keys (no values)', {
      traceId,
      keys: Object.keys(insertPayload),
      status: PrescriptionStatus.PROCESSING,
    });

    const { error: prescError } = await supabaseAdmin.from('prescriptions').insert(insertPayload);
    if (prescError) {
      const e = prescError as SupabaseErrorLike;
      console.error('[PRESCRIPTIONS] import-pdf Supabase error', {
        traceId,
        stepName: stepPrescriptionsInsert,
        code: e.code,
        message: e.message,
        details: e.details,
        hint: e.hint,
      });
      if (e.code === 'PGRST204' || String(e.message ?? '').includes('not found in schema cache')) {
        const columnMatch = String(e.message ?? '').match(/'([^']+)'/);
        const columnHint = columnMatch ? columnMatch[1] : 'unknown';
        console.error('[PRESCRIPTIONS] import-pdf PGRST204 insertPayload keys', { traceId, keys: Object.keys(insertPayload) });
        return res.status(500).json({
          ok: false,
          error: 'SCHEMA_CACHE_OUTDATED',
          message: `Colonne manquante/${columnHint}`,
          traceId,
        });
      }
      return res.status(500).json({
        ok: false,
        error: 'DB_INSERT_FAILED',
        step: stepPrescriptionsInsert,
        code: e.code ?? null,
        message: e.message ?? null,
        details: e.details ?? null,
        hint: e.hint ?? null,
        traceId,
      });
    }

    const stepFilesInsert = 'prescription_files_insert';
    console.log('[PRESCRIPTIONS] import-pdf step', { traceId, stepName: stepFilesInsert });
    // storage_path NON NULL (calculé avant upload). Pas de bucket/original_name si colonnes incertaines.
    const filesInsertPayload: Record<string, unknown> = {
      prescription_id: prescriptionId,
      user_id: userId,
      profile_id: profileId,
      storage_path: storagePath,
      mime_type: contentType,
      size_bytes: size,
      meta: { source: 'pdf' },
    };
    const { error: fileError } = await supabaseAdmin.from('prescription_files').insert(filesInsertPayload);
    if (fileError) {
      const e = fileError as SupabaseErrorLike;
      console.error('[PRESCRIPTIONS] import-pdf Supabase error', { traceId, stepName: stepFilesInsert, code: e.code, message: e.message });
      await supabaseAdmin.from('prescriptions').update({ status: PrescriptionStatus.ERROR }).eq('id', prescriptionId);
      if (e.code === 'PGRST204' || String(e.message ?? '').includes('not found in schema cache')) {
        const columnMatch = String(e.message ?? '').match(/'([^']+)'/);
        const columnHint = columnMatch ? columnMatch[1] : 'unknown';
        return res.status(500).json({
          ok: false,
          error: 'SCHEMA_CACHE_OUTDATED',
          step: stepFilesInsert,
          message: `Colonne manquante/${columnHint}`,
          traceId,
        });
      }
      return res.status(500).json({
        ok: false,
        error: 'DB_INSERT_FAILED',
        step: stepFilesInsert,
        code: e.code ?? null,
        message: e.message ?? null,
        traceId,
      });
    }

    const setPrescriptionError = async () => {
      await supabaseAdmin.from('prescriptions').update({ status: PrescriptionStatus.ERROR }).eq('id', prescriptionId);
    };

    try {
      const stepExtractText = 'extract_text';
      console.log('[PRESCRIPTIONS] import-pdf step', { traceId, stepName: stepExtractText });
      let rawText = '';
      if (contentType === 'application/pdf') {
        try {
          const parsed = await pdfParse(buffer);
          rawText = (parsed.text || '').replace(/\s+/g, ' ').trim();
        } catch {
          rawText = '';
        }
      }

      const rawTextUsable = rawText && rawText.length >= 30;

      if (!rawTextUsable) {
        console.log('[PRESCRIPTIONS] import-pdf status utilisé', { traceId, status: PrescriptionStatus.MANUAL_REQUIRED });
        await supabaseAdmin
          .from('prescriptions')
          .update({
            status: PrescriptionStatus.MANUAL_REQUIRED,
            raw_text: null,
            data: { source: 'pdf', extraction: 'empty' },
          })
          .eq('id', prescriptionId);
        return res.status(200).json({
          ok: true,
          prescriptionId,
          status: PrescriptionStatus.MANUAL_REQUIRED,
          rawTextPreview: '',
          data: { source: 'pdf', extraction: 'empty' },
        });
      }

      const stepParseAi = 'parse_ai';
      console.log('[PRESCRIPTIONS] import-pdf step', { traceId, stepName: stepParseAi });
      let extracted: PrescriptionStruct = {
        date_ordonnance: null,
        medecin: null,
        patient: null,
        items: [],
      };
      const openaiKey =
        process.env.OPENAI_API_KEY || (req.app?.locals && (req.app.locals as { OPENAI_API_KEY?: string }).OPENAI_API_KEY);
      if (openaiKey) {
        try {
          extracted = await structurizePrescriptionText({ openaiApiKey: openaiKey, rawText });
        } catch (err) {
          console.error('[PRESCRIPTIONS] import-pdf OpenAI struct:', err);
        }
      }

      const items = Array.isArray(extracted.items) ? extracted.items : [];
      const stepItemsInsert = 'prescription_items_insert';
      if (items.length > 0) {
        console.log('[PRESCRIPTIONS] import-pdf step', { traceId, stepName: stepItemsInsert });
        // Aucun champ dynamique (dosage/duree/frequence_par_jour/etc.) : uniquement data (JSONB) + label/raw_line/idx.
        const rows = items.slice(0, 500).map((item, index) => ({
          prescription_id: prescriptionId,
          user_id: userId,
          profile_id: profileId,
          idx: index,
          label: (item as { nom?: string | null }).nom ?? '',
          raw_line: '',
          data: item as Record<string, unknown>,
        }));
        const { error: itemsError } = await supabaseAdmin.from('prescription_items').insert(rows);
        if (itemsError) {
          const e = itemsError as SupabaseErrorLike;
          console.error('[PRESCRIPTIONS] import-pdf Supabase error', { traceId, stepName: stepItemsInsert, code: e.code, message: e.message });
          await setPrescriptionError();
          if (e.code === 'PGRST204' || String(e.message ?? '').includes('not found in schema cache')) {
            const columnMatch = String(e.message ?? '').match(/'([^']+)'/);
            const columnHint = columnMatch ? columnMatch[1] : 'unknown';
            return res.status(500).json({
              ok: false,
              error: 'SCHEMA_CACHE_OUTDATED',
              step: stepItemsInsert,
              message: `Colonne manquante/${columnHint}. prescription_items doit avoir: prescription_id, user_id, profile_id, idx, label, raw_line, data (JSONB).`,
              traceId,
            });
          }
          return res.status(500).json({
            ok: false,
            error: 'DB_INSERT_FAILED',
            step: stepItemsInsert,
            code: e.code ?? null,
            message: e.message ?? null,
            traceId,
          });
        }
      }

      const stepPrescriptionsUpdate = 'prescriptions_update';
      console.log('[PRESCRIPTIONS] import-pdf step', { traceId, stepName: stepPrescriptionsUpdate });
      const prescriptionData = {
        date_ordonnance: extracted.date_ordonnance ?? null,
        medecin: extracted.medecin ?? null,
        patient: extracted.patient ?? null,
        items: extracted.items ?? [],
      };
      const { error: updateError } = await supabaseAdmin
        .from('prescriptions')
        .update({
          status: PrescriptionStatus.READY,
          raw_text: rawText,
          data: prescriptionData,
        })
        .eq('id', prescriptionId);
      if (updateError) {
        const e = updateError as SupabaseErrorLike;
        console.error('[PRESCRIPTIONS] import-pdf update prescription error', { traceId, code: e.code, message: e.message });
        await setPrescriptionError();
        return res.status(500).json({
          ok: false,
          error: 'DB_INSERT_FAILED',
          step: stepPrescriptionsUpdate,
          code: e.code ?? null,
          message: e.message ?? null,
          traceId,
        });
      }

      const rawTextPreview = rawText.length > 300 ? rawText.slice(0, 300) + '…' : rawText;
      return res.status(200).json({
        ok: true,
        prescriptionId,
        status: PrescriptionStatus.READY,
        rawTextPreview,
        data: prescriptionData,
      });
    } catch (err) {
      console.error('[PRESCRIPTIONS] import-pdf exception', { traceId, error: err });
      await setPrescriptionError();
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : 'Erreur lors de l\'import',
        traceId,
      });
    }
  }
);

const SIGNED_URL_EXPIRES_IN = 3600; // 1h

/**
 * GET /api/prescriptions
 *
 * Liste les prescriptions de l'utilisateur (requireUser).
 */
router.get('/', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { userId?: string }).userId;
    if (!userId) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise',
      });
    }

    const { data, error } = await supabaseAdmin
      .from('prescriptions')
      .select('id, profile_id, raw_text, statut, status, created_at')
      .or(`owner_user_id.eq.${userId},user_id.eq.${userId}`)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      console.error('[PRESCRIPTIONS] list:', error);
      return res.status(500).json({
        ok: false,
        error: 'DATABASE_ERROR',
        message: 'Erreur lors de la récupération des prescriptions',
      });
    }

    return res.status(200).json({ ok: true, prescriptions: data ?? [] });
  } catch (err) {
    console.error('[PRESCRIPTIONS] list error:', err);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Erreur serveur',
    });
  }
});

/**
 * GET /api/prescriptions/:id
 *
 * Auth requireUser. Charge prescription (doit appartenir à req.userId),
 * 1er prescription_files, prescription_items. Génère signedUrl (3600s).
 * Réponse: { ok: true, prescription: {...}, file: {...signedUrl}, items: [...] }
 */
router.get('/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { userId?: string }).userId;
    if (!userId) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise',
      });
    }

    const id = req.params.id?.trim();
    if (!id) {
      return res.status(400).json({
        ok: false,
        error: 'BAD_REQUEST',
        message: 'ID de prescription requis',
      });
    }

    const { data: prescription, error: prescError } = await supabaseAdmin
      .from('prescriptions')
      .select('*')
      .eq('id', id)
      .or(`owner_user_id.eq.${userId},user_id.eq.${userId}`)
      .maybeSingle();

    if (prescError) {
      console.error('[PRESCRIPTIONS] get by id:', prescError);
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
        message: 'Prescription introuvable',
      });
    }

    const { data: files } = await supabaseAdmin
      .from('prescription_files')
      .select('storage_path, mime_type, size_bytes, original_name')
      .eq('prescription_id', id)
      .limit(1);

    const firstFile = Array.isArray(files) && files.length > 0 ? files[0] : null;
    const filePath = firstFile?.storage_path ?? (firstFile as { path?: string } | undefined)?.path;
    const fileBucket = (firstFile as { bucket?: string } | undefined)?.bucket ?? BUCKET;
    let filePayload: { signedUrl: string; bucket: string; storage_path: string; mime_type: string | null; size: number | null; original_name: string | null } | null = null;

    if (firstFile && filePath) {
      try {
        const signedUrl = await createSignedUrl({
          bucket: fileBucket,
          path: filePath,
          expiresIn: SIGNED_URL_EXPIRES_IN,
        });
        const sizeVal = (firstFile as { size?: number; size_bytes?: number }).size ?? (firstFile as { size_bytes?: number }).size_bytes ?? null;
        filePayload = {
          signedUrl,
          bucket: fileBucket,
          storage_path: filePath,
          mime_type: firstFile.mime_type ?? null,
          size: sizeVal,
          original_name: firstFile.original_name ?? null,
        };
      } catch (urlErr) {
        console.error('[PRESCRIPTIONS] signed url:', urlErr);
      }
    }

    const { data: items } = await supabaseAdmin
      .from('prescription_items')
      .select('*')
      .eq('prescription_id', id)
      .order('created_at', { ascending: true });

    return res.status(200).json({
      ok: true,
      prescription,
      file: filePayload,
      items: items ?? [],
    });
  } catch (err) {
    console.error('[PRESCRIPTIONS] get by id error:', err);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Erreur serveur',
    });
  }
});

/**
 * Body JSON pour PATCH /api/prescriptions/:id (écran de vérification)
 */
type PatchPrescriptionBody = {
  status?: PrescriptionStatusType;
  date_ordonnance?: string | null;
  medecin?: { nom?: string | null; prenom?: string | null; rpps?: string | null };
  patient?: { nom?: string | null; prenom?: string | null; date_naissance?: string | null };
  items?: Array<{
    id?: string;
    nom: string;
    dosage?: string | null;
    forme?: string | null;
    frequence_par_jour?: number | null;
    moment?: string | null;
    duree?: string | null;
    instructions?: string | null;
  }>;
};

/**
 * PATCH /api/prescriptions/:id
 *
 * Sauvegarde écran de vérification. Auth requireUser.
 * Update prescriptions (status, date_ordonnance, medecin_*, patient_*).
 * Upsert items : item.id présent => update, sinon insert ; supprimer les items absents de la liste si items fourni.
 * Retour: { ok: true }
 */
router.patch('/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { userId?: string }).userId;
    if (!userId) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise',
      });
    }

    const id = req.params.id?.trim();
    if (!id) {
      return res.status(400).json({
        ok: false,
        error: 'BAD_REQUEST',
        message: 'ID de prescription requis',
      });
    }

    const { data: prescription, error: prescError } = await supabaseAdmin
      .from('prescriptions')
      .select('id')
      .eq('id', id)
      .or(`owner_user_id.eq.${userId},user_id.eq.${userId}`)
      .maybeSingle();

    if (prescError) {
      console.error('[PRESCRIPTIONS] patch load:', prescError);
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
        message: 'Prescription introuvable',
      });
    }

    const body = (req.body || {}) as PatchPrescriptionBody;

    const updatePresc: Record<string, unknown> = {};
    if (body.status !== undefined) {
      if (!isPrescriptionStatus(body.status)) {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: `status doit être l'un de: ${PRESCRIPTION_STATUS_VALUES.join(', ')}`,
        });
      }
      updatePresc.status = body.status;
    }
    if (body.date_ordonnance !== undefined) updatePresc.date_ordonnance = body.date_ordonnance ?? null;
    if (body.medecin !== undefined) {
      updatePresc.medecin_nom = body.medecin.nom ?? null;
      updatePresc.medecin_prenom = body.medecin.prenom ?? null;
      updatePresc.medecin_rpps = body.medecin.rpps ?? null;
    }
    if (body.patient !== undefined) {
      updatePresc.patient_nom = body.patient.nom ?? null;
      updatePresc.patient_prenom = body.patient.prenom ?? null;
      updatePresc.patient_date_naissance = body.patient.date_naissance ?? null;
    }

    if (Object.keys(updatePresc).length > 0) {
      const { error: updateError } = await supabaseAdmin
        .from('prescriptions')
        .update(updatePresc)
        .eq('id', id);

      if (updateError) {
        console.error('[PRESCRIPTIONS] patch update prescription:', updateError);
        return res.status(500).json({
          ok: false,
          error: 'DATABASE_ERROR',
          message: 'Erreur lors de la mise à jour de la prescription',
        });
      }
    }

    if (body.items !== undefined) {
      const items = Array.isArray(body.items) ? body.items : [];
      const keptIds: string[] = [];

      for (const item of items) {
        const nom = typeof item.nom === 'string' ? item.nom.trim() : '';
        const row = {
          prescription_id: id,
          nom: nom || null,
          dosage: item.dosage ?? null,
          forme: item.forme ?? null,
          frequence_par_jour: item.frequence_par_jour ?? null,
          moment: item.moment ?? null,
          duree: item.duree ?? null,
          instructions: item.instructions ?? null,
        };

        if (item.id && item.id.trim()) {
          const { error: upErr } = await supabaseAdmin
            .from('prescription_items')
            .update(row)
            .eq('id', item.id.trim())
            .eq('prescription_id', id);

          if (!upErr) keptIds.push(item.id.trim());
          else console.error('[PRESCRIPTIONS] patch update item:', upErr);
        } else {
          const { data: inserted } = await supabaseAdmin
            .from('prescription_items')
            .insert(row)
            .select('id')
            .single();

          if (inserted?.id) keptIds.push(inserted.id);
        }
      }

      const { data: existingItems } = await supabaseAdmin
        .from('prescription_items')
        .select('id')
        .eq('prescription_id', id);

      const toDelete = (existingItems ?? [])
        .map((r) => r.id)
        .filter((itemId) => itemId && !keptIds.includes(itemId));

      if (toDelete.length > 0) {
        await supabaseAdmin
          .from('prescription_items')
          .delete()
          .eq('prescription_id', id)
          .in('id', toDelete);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[PRESCRIPTIONS] patch error:', err);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Erreur serveur',
    });
  }
});

export default router;
