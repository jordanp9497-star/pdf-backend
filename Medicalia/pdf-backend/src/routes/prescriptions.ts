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

import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import os from 'os';
import fs from 'fs/promises';
import pdfParse from 'pdf-parse';
import { randomUUID } from 'crypto';
import { requireUser } from '../../middlewares/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import {
  uploadBufferToStorage,
  createSignedUrl,
  isBucketNotFoundError,
  getPrescriptionStoragePathDeterministic,
  getPhotoStoragePath,
  normalizeOriginalFilename,
} from '../services/storageService.js';
import { structurizePrescriptionText } from '../services/prescriptionStructService.js';
import type { PrescriptionStruct } from '../schemas/prescriptionStruct.js';
import { AI_CONFIG } from '../config/env.js';

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

/** Nom de fichier safe pour tmp (diskStorage). */
function safeTmpFilename(): string {
  const ext = '.pdf';
  const safe = `${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 12)}${ext}`;
  return safe;
}

/** Multer pour import-pdf : diskStorage (os.tmpdir()), champ "file", 10MB. Ne jamais lire tout le fichier en Buffer avant ACK. */
const uploadImportPdf = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, _file, cb) => cb(null, safeTmpFilename()),
  }),
  limits: { fileSize: UPLOAD_LIMIT },
});

const PHOTO_UPLOAD_LIMIT = 10 * 1024 * 1024; // 10MB
/** Multer pour import-photo : champ "file", image/jpeg/png/webp/heic/heif, 10MB. */
const uploadImportPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PHOTO_UPLOAD_LIMIT },
  fileFilter: (_req, file, cb) => {
    // Support formats modernes : WebP (Android), HEIC/HEIF (iOS)
    const ok = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(file.mimetype || '');
    cb(null, ok);
  },
});

export type TmpFileInfo = {
  tmpPath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
};

/**
 * Helper: infos du fichier tmp (multer diskStorage).
 * Retourne null si req.file absent.
 */
export function getTmpFileInfo(file: Express.Multer.File | undefined): TmpFileInfo | null {
  if (!file || !file.path) return null;
  const tmpPath = typeof file.path === 'string' ? file.path : (file as { path?: string }).path ?? '';
  if (!tmpPath) return null;
  return {
    tmpPath,
    originalName: file.originalname ?? 'document.pdf',
    mimeType: file.mimetype ?? 'application/octet-stream',
    sizeBytes: file.size ?? 0,
  };
}

const LOG_PREFIX = '[IMPORT_PDF]';
const OPENAI_TIMEOUT_MS = 15000;

/** Middleware: log start/end + durée + traceId pour import-pdf (isolant 502). */
function importPdfLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const traceId = randomUUID();
  (req as Request & { importPdfTraceId?: string }).importPdfTraceId = traceId;
  const start = Date.now();
  console.log(`${LOG_PREFIX}[${traceId}][middleware_start]`);
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    console.log(`${LOG_PREFIX}[${traceId}][middleware_end] duration_ms=${durationMs}`);
  });
  next();
}

type ProcessPrescriptionPdfParams = {
  prescriptionId: string;
  userId: string;
  profileId: string;
  storagePath: string;
  tmpPath: string;
  contentType: string;
  originalName: string;
  sizeBytes: number;
  traceId: string;
};

/**
 * Phase 2 (async) : upload Storage, insert prescription_files, extraction PDF, OpenAI, update prescription, insert items.
 * Tous les steps en try/catch avec [IMPORT_PDF][traceId][step]. Si erreur => status='error' + data={error, step}.
 */
function processPrescriptionPdf(params: ProcessPrescriptionPdfParams): Promise<void> {
  const { prescriptionId, userId, profileId, storagePath, tmpPath, contentType, originalName, sizeBytes, traceId } = params;
  const stepName = (name: string) => `${LOG_PREFIX}[${traceId}][${name}]`;

  const setError = async (step: string, err?: unknown) => {
    try {
      const msg = err instanceof Error ? err.message : String(err ?? step);
      console.error(stepName(step), err ?? step);
      await supabaseAdmin
        .from('prescriptions')
        .update({ status: PrescriptionStatus.ERROR, data: { error: msg, step } })
        .eq('id', prescriptionId);
    } catch (e) {
      console.error(stepName('setError'), e);
    }
  };

  return (async () => {
    let buffer: Buffer | null = null;
    try {
      // --- read_tmp ---
      try {
        console.log(stepName('read_tmp'), tmpPath);
        buffer = await fs.readFile(tmpPath);
      } catch (e) {
        await setError('read_tmp', e);
        return;
      }

      // --- storage_upload ---
      try {
        console.log(stepName('storage_upload'));
        await uploadBufferToStorage({
          bucket: BUCKET,
          path: storagePath,
          buffer: buffer!,
          contentType,
        });
      } catch (e) {
        await setError('storage_upload', e);
        return;
      }

      // --- prescription_files_insert (storage_path non-null après upload) ---
      try {
        console.log(stepName('prescription_files_insert'));
        const { error: fileErr } = await supabaseAdmin.from('prescription_files').insert({
          prescription_id: prescriptionId,
          user_id: userId,
          profile_id: profileId,
          storage_path: storagePath,
          original_name: originalName,
          mime_type: contentType,
          size_bytes: sizeBytes,
          meta: { source: 'pdf' },
        });
        if (fileErr) {
          await setError('prescription_files_insert', fileErr);
          return;
        }
      } catch (e) {
        await setError('prescription_files_insert', e);
        return;
      }

      // --- extract_text ---
      console.log(stepName('extract_text'));
      let rawText = '';
      try {
        const parsed = await pdfParse(buffer);
        rawText = ((parsed as { text?: string }).text || '').replace(/\s+/g, ' ').trim();
      } catch (e) {
        await setError('extract_text', e);
        return;
      }

      if (!rawText || rawText.length < 30) {
        console.log(stepName('manual_required'), 'rawText empty or < 30');
        await supabaseAdmin
          .from('prescriptions')
          .update({
            status: PrescriptionStatus.MANUAL_REQUIRED,
            raw_text: null,
            data: { source: 'pdf', extraction: 'empty' },
          })
          .eq('id', prescriptionId);
        return;
      }

      // --- parse_ai (timeout 15s) ---
      console.log(stepName('parse_ai'));
      const openaiKey = process.env.OPENAI_API_KEY;
      let extracted: PrescriptionStruct = {
        date_ordonnance: null,
        medecin: null,
        patient: null,
        items: [],
      };
      if (openaiKey) {
        try {
          const timeoutPromise = new Promise<PrescriptionStruct>((_, reject) =>
            setTimeout(() => reject(new Error('OPENAI_TIMEOUT')), OPENAI_TIMEOUT_MS)
          );
          extracted = await Promise.race([
            structurizePrescriptionText({ openaiApiKey: openaiKey, rawText }),
            timeoutPromise,
          ]);
        } catch (e) {
          console.error(stepName('parse_ai'), e);
          await supabaseAdmin
            .from('prescriptions')
            .update({
              status: PrescriptionStatus.MANUAL_REQUIRED,
              raw_text: null,
              data: { error: 'ai_failed' },
            })
            .eq('id', prescriptionId);
          return;
        }
      }

      const prescriptionData = {
        date_ordonnance: extracted.date_ordonnance ?? null,
        medecin: extracted.medecin ?? null,
        patient: extracted.patient ?? null,
        items: extracted.items ?? [],
      };

      // --- prescription_items_insert ---
      const items = Array.isArray(extracted.items) ? extracted.items : [];
      if (items.length > 0) {
        console.log(stepName('prescription_items_insert'));
        type ItemLike = { nom?: string | null; label?: string | null; raw_line?: string | null; [k: string]: unknown };
        const rows = items.slice(0, 500).map((item: ItemLike, index: number) => ({
          prescription_id: prescriptionId,
          user_id: userId,
          profile_id: profileId,
          idx: index,
          label: item.nom ?? item.label ?? null,
          raw_line: item.raw_line ?? null,
          data: item as Record<string, unknown>,
        }));
        const { error: itemsErr } = await supabaseAdmin.from('prescription_items').insert(rows);
        if (itemsErr) {
          await setError('prescription_items_insert', itemsErr);
          return;
        }
      }

      // --- prescriptions_update (ready) ---
      console.log(stepName('prescriptions_update'));
      const { error: updateErr } = await supabaseAdmin
        .from('prescriptions')
        .update({
          status: PrescriptionStatus.READY,
          raw_text: rawText,
          data: prescriptionData,
        })
        .eq('id', prescriptionId);
      if (updateErr) {
        await setError('prescriptions_update', updateErr);
        return;
      }
      console.log(stepName('done'), PrescriptionStatus.READY);
    } catch (err) {
      console.error(stepName('exception'), err);
      await setError('exception', err);
    } finally {
      try {
        await fs.unlink(tmpPath);
      } catch (_) {
        // ignore unlink errors (file may already be gone)
      }
    }
  })();
}

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
 * POST /api/prescriptions/import-pdf/debug
 *
 * Même multer que import-pdf. Répond immédiatement { ok: true, file: { originalname, mimetype, size } } sans toucher Supabase.
 * But: isoler si le 502 vient de la lecture multipart/multer ou de la logique métier.
 */
router.post(
  '/import-pdf/debug',
  uploadImportPdf.single('file'),
  (req: Request, res: Response) => {
    try {
      const fileInfo = getTmpFileInfo(req.file);
      if (fileInfo) {
        return res.status(200).json({
          ok: true,
          file: {
            originalname: fileInfo.originalName,
            mimetype: fileInfo.mimeType,
            size: fileInfo.sizeBytes,
          },
        });
      }
      return res.status(400).json({
        ok: false,
        error: 'MISSING_FILE',
        message: 'Le champ fichier "file" est obligatoire',
      });
    } catch (err) {
      console.error('[IMPORT_PDF][debug]', err);
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
);

/**
 * POST /api/prescriptions/import-pdf (mode manuel)
 *
 * Crée prescription (status=manual_required, needs_review=true, document_kind=medicament, doc_context=general),
 * enregistre le fichier dans Storage + prescription_files. Pas d'OCR/parsing.
 * Réponse: { ok, prescription_id, file_id, mime_type, storage_path }.
 */
router.post(
  '/import-pdf',
  requireUser,
  importPdfLogMiddleware,
  uploadImportPdf.single('file'),
  async (req: Request, res: Response) => {
    const traceId = (req as Request & { importPdfTraceId?: string }).importPdfTraceId ?? randomUUID();
    type ReqWithUser = Request & { userId?: string };
    const reqUser = req as ReqWithUser;
    const userId = reqUser.userId;

    try {
      console.log(`${LOG_PREFIX}[${traceId}][start]`, { userId: userId ?? null, bodyKeys: Object.keys(req.body || {}) });

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
      console.error(`${LOG_PREFIX}[${traceId}][profile_fetch]`, profileError);
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

    const fileInfo = getTmpFileInfo(req.file);
    if (!fileInfo) {
      return res.status(400).json({
        ok: false,
        error: 'MISSING_FILE',
        message: 'Le champ fichier "file" est obligatoire',
      });
    }

    const { tmpPath, originalName, mimeType, sizeBytes } = fileInfo;
    console.log(`${LOG_PREFIX}[${traceId}][file]`, { tmpPath, size: sizeBytes });

    const needsManualRaw = req.body?.needsManual ?? req.body?.needs_manual;
    const needsManual = String(needsManualRaw ?? '').toLowerCase() === 'true';

    const originalNameForDb = normalizeOriginalFilename(originalName);
    const prescriptionId = randomUUID();
    const storagePath = getPrescriptionStoragePathDeterministic(userId, profileId, prescriptionId, originalNameForDb);
    if (!storagePath || !storagePath.trim()) {
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'storage_path vide',
        traceId,
      });
    }

    type SupabaseErrorLike = { code?: string; message?: string; details?: string; hint?: string };
    console.log(`${LOG_PREFIX}[${traceId}][prescriptions_insert]`);

    const insertPayload: Record<string, unknown> = {
      id: prescriptionId,
      user_id: userId,
      owner_user_id: userId,
      profile_id: profileId,
      status: needsManual ? PrescriptionStatus.MANUAL_REQUIRED : PrescriptionStatus.PROCESSING,
      needs_review: needsManual ? true : false,
      document_kind: 'medicament',
      doc_context: 'general',
      raw_text: null,
      data: {},
    };

    const { error: prescError } = await supabaseAdmin.from('prescriptions').insert(insertPayload);
    if (prescError) {
      const e = prescError as SupabaseErrorLike;
      console.error(`${LOG_PREFIX}[${traceId}][prescriptions_insert]`, e.code, e.message);
      if (e.code === 'PGRST204' || String(e.message ?? '').includes('not found in schema cache')) {
        const columnMatch = String(e.message ?? '').match(/'([^']+)'/);
        const columnHint = columnMatch ? columnMatch[1] : 'unknown';
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
        step: 'prescriptions_insert',
        code: e.code ?? null,
        message: e.message ?? null,
        details: e.details ?? null,
        hint: e.hint ?? null,
        traceId,
      });
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(tmpPath);
    } catch (readErr) {
      console.error(`${LOG_PREFIX}[${traceId}][read_tmp]`, readErr);
      return res.status(500).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Impossible de lire le fichier temporaire',
        traceId,
      });
    }

    try {
      await uploadBufferToStorage({
        bucket: BUCKET,
        path: storagePath,
        buffer,
        contentType: mimeType,
      });
    } catch (uploadErr) {
      console.error(`${LOG_PREFIX}[${traceId}][storage_upload]`, uploadErr);
      if (isBucketNotFoundError(uploadErr)) {
        return res.status(500).json({
          ok: false,
          error: 'BUCKET_NOT_FOUND',
          message: 'Bucket Storage "prescriptions" introuvable',
          traceId,
        });
      }
      return res.status(500).json({
        ok: false,
        error: 'STORAGE_UPLOAD_FAILED',
        message: uploadErr instanceof Error ? uploadErr.message : 'Upload échoué',
        traceId,
      });
    }

    const { data: fileRow, error: fileErr } = await supabaseAdmin
      .from('prescription_files')
      .insert({
        prescription_id: prescriptionId,
        user_id: userId,
        profile_id: profileId,
        storage_path: storagePath,
        original_name: originalName ?? originalNameForDb,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        meta: { source: 'pdf' },
      })
      .select('id')
      .single();

    if (needsManual) {
      try {
        await fs.unlink(tmpPath);
      } catch (_) {
        // ignore
      }
    }

    if (fileErr || !fileRow) {
      console.error(`${LOG_PREFIX}[${traceId}][prescription_files_insert]`, fileErr);
      return res.status(500).json({
        ok: false,
        error: 'DB_INSERT_FAILED',
        step: 'prescription_files_insert',
        message: fileErr?.message ?? null,
        traceId,
      });
    }

    // Lancer le traitement OCR/parse en background si mode auto
    if (!needsManual) {
      processPrescriptionPdf({
        prescriptionId,
        userId,
        profileId,
        storagePath,
        tmpPath,
        contentType: mimeType,
        originalName: originalNameForDb,
        sizeBytes,
        traceId,
      }).catch((e) => console.error(`${LOG_PREFIX}[${traceId}][process_async]`, e));
    }

    return res.status(200).json({
      ok: true,
      prescription_id: prescriptionId,
      file_id: fileRow.id,
      mime_type: mimeType,
      storage_path: storagePath,
      traceId,
      prescriptionId,
      fileId: fileRow.id,
      mimeType: mimeType,
      storagePath: storagePath,
      status: needsManual ? PrescriptionStatus.MANUAL_REQUIRED : PrescriptionStatus.PROCESSING,
      needs_manual: needsManual,
    });
    } catch (err) {
      console.error(`${LOG_PREFIX}[${traceId}][sync_error]`, err);
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : 'Erreur lors de l\'import',
          traceId,
        });
      }
    }
  }
);

const LOG_PREFIX_PHOTO = '[PRESCRIPTIONS][import-photo]';
const OPENAI_TIMEOUT_MS_PHOTO = 15000;
const MISTRAL_OCR_TIMEOUT_MS = 45000;
const OPENAI_OCR_TIMEOUT_MS = 45000;

/**
 * OCR image via Mistral vision API. Retourne le texte brut ou '' si échec / pas de clé.
 */
async function ocrImageWithMistral(buffer: Buffer, mimeType: string, traceId: string): Promise<string> {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) {
    console.log(`${LOG_PREFIX_PHOTO}[${traceId}][ocr] MISTRAL_API_KEY absent`);
    return '';
  }
  const base64 = buffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MISTRAL_OCR_TIMEOUT_MS);
  try {
    const res = await fetch(AI_CONFIG.mistralApiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mistral-large-latest',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Extrais le texte de cette ordonnance médicale française. Retourne uniquement le texte brut sans commentaire.' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      console.error(`${LOG_PREFIX_PHOTO}[${traceId}][ocr] Mistral status`, res.status);
      return '';
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data?.choices?.[0]?.message?.content ?? '';
    return (text || '').replace(/\s+/g, ' ').trim();
  } catch (e) {
    clearTimeout(timeoutId);
    console.error(`${LOG_PREFIX_PHOTO}[${traceId}][ocr] Mistral`, e);
    return '';
  }
}

/**
 * OCR image : Mistral uniquement (OpenAI désactivé).
 */
async function ocrImage(buffer: Buffer, mimeType: string, traceId: string): Promise<string> {
  let rawText = await ocrImageWithMistral(buffer, mimeType, traceId);
  return (rawText || '').trim();
}

/**
 * Traitement en background après réponse HTTP : OCR + parse, update prescriptions + prescription_items.
 */
function processPrescriptionPhoto(params: {
  prescriptionId: string;
  userId: string;
  profileId: string;
  buffer: Buffer;
  mimeType: string;
  traceId: string;
}): void {
  const { prescriptionId, userId, profileId, buffer, mimeType, traceId } = params;
  const step = (name: string) => `${LOG_PREFIX_PHOTO}[${traceId}][${name}]`;

  const setError = async (stepName: string, err: unknown) => {
    try {
      console.error(step(stepName), err);
      await supabaseAdmin
        .from('prescriptions')
        .update({ status: PrescriptionStatus.ERROR, data: { error: String(err instanceof Error ? err.message : err), step: stepName } })
        .eq('id', prescriptionId);
    } catch (e) {
      console.error(step('setError'), e);
    }
  };

  setImmediate(async () => {
    try {
      // 1) OCR -> raw_text (Mistral puis fallback OpenAI Vision)
      console.log(step('ocr'));
      const rawText = await ocrImage(buffer, mimeType, traceId);
      if (!rawText || rawText.length < 30) {
        console.log(step('manual_required'), 'rawText vide ou < 30');
        await supabaseAdmin
          .from('prescriptions')
          .update({ status: PrescriptionStatus.MANUAL_REQUIRED, raw_text: null, data: { source: 'photo', extraction: 'empty' } })
          .eq('id', prescriptionId);
        return;
      }

      // OpenAI désactivé: on ne structure pas automatiquement.
      // On sauvegarde le raw_text et on met MANUAL_REQUIRED pour forcer la vérification manuelle côté app.
      console.log(step('prescriptions_update'), PrescriptionStatus.MANUAL_REQUIRED);
      const { error: updateErr } = await supabaseAdmin
        .from('prescriptions')
        .update({
          status: PrescriptionStatus.MANUAL_REQUIRED,
          raw_text: rawText,
          data: { source: 'photo', extraction: 'ocr_only' },
        })
        .eq('id', prescriptionId);
      if (updateErr) {
        await setError('prescriptions_update', updateErr);
      }
      return;
      console.log(step('done'), finalStatus);
    } catch (err) {
      console.error(step('exception'), err);
      setError('exception', err).catch((e) => console.error(step('setError'), e));
    }
  });
}

/**
 * POST /api/prescriptions/import-photo (mode manuel)
 *
 * Multipart: profile_id (string), file (image/jpeg ou image/png). Auth Bearer obligatoire.
 * Crée prescription (status=manual_required, needs_review=true, document_kind=medicament, doc_context=general),
 * enregistre le fichier dans Storage + prescription_files. Pas d'OCR/parsing.
 * Réponse: { ok, prescription_id, file_id, mime_type, storage_path }.
 */
router.post(
  '/import-photo',
  requireUser,
  uploadImportPhoto.single('file'),
  async (req: Request, res: Response) => {
    const traceId = randomUUID();
    type ReqWithUser = Request & { userId?: string; user?: { id: string } };
    const reqUser = req as ReqWithUser;
    const userId = reqUser.userId ?? reqUser.user?.id;

    try {
      console.log(`${LOG_PREFIX_PHOTO}[${traceId}][start]`);

      if (!userId) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Authentification requise' });
      }

      const profileIdRaw = req.body?.profile_id;
      const profileId = typeof profileIdRaw === 'string' ? profileIdRaw.trim() : '';
      if (!profileId) {
        return res.status(400).json({ ok: false, error: 'MISSING_PROFILE_ID', message: 'Le champ profile_id est obligatoire', traceId });
      }

      const { data: profile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('id', profileId)
        .eq('owner_user_id', userId)
        .maybeSingle();

      if (profileError) {
        console.error(`${LOG_PREFIX_PHOTO}[${traceId}][profile_fetch]`, profileError);
        return res.status(500).json({ ok: false, error: 'DB_ERROR', message: profileError.message ?? 'Erreur profil', traceId });
      }
      if (!profile) {
        return res.status(403).json({ ok: false, error: 'PROFILE_FORBIDDEN', message: 'Profil introuvable ou accès refusé', profileId, traceId });
      }

      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ ok: false, error: 'MISSING_FILE', message: 'Le champ fichier "file" est obligatoire', traceId });
      }

      const buffer = req.file.buffer as Buffer;
      const originalname = req.file.originalname ?? 'photo.jpg';
      const mimetype = req.file.mimetype ?? 'image/jpeg';
      const size = buffer.length;

      console.log(`${LOG_PREFIX_PHOTO}[${traceId}][file]`, { originalname, mimetype, size });

      const prescriptionId = randomUUID();
      const storagePath = getPhotoStoragePath(profileId, prescriptionId, originalname);
      if (!storagePath || !storagePath.trim()) {
        return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: 'storage_path vide', traceId });
      }

      console.log(`${LOG_PREFIX_PHOTO}[${traceId}][storage_upload]`);
      try {
        await uploadBufferToStorage({ bucket: BUCKET, path: storagePath, buffer, contentType: mimetype });
      } catch (storageErr: unknown) {
        console.error(`${LOG_PREFIX_PHOTO}[${traceId}][storage_upload]`, storageErr);
        if (isBucketNotFoundError(storageErr)) {
          return res.status(500).json({
            ok: false,
            error: 'BUCKET_NOT_FOUND',
            message: 'Bucket Storage "prescriptions" introuvable',
            traceId,
          });
        }
        return res.status(500).json({
          ok: false,
          error: 'STORAGE_UPLOAD_FAILED',
          message: storageErr instanceof Error ? storageErr.message : 'Upload échoué',
          traceId,
        });
      }

      console.log(`${LOG_PREFIX_PHOTO}[${traceId}][prescriptions_insert]`);
      const insertPayload: Record<string, unknown> = {
        id: prescriptionId,
        user_id: userId,
        owner_user_id: userId,
        profile_id: profileId,
        status: PrescriptionStatus.MANUAL_REQUIRED,
        needs_review: true,
        document_kind: 'medicament',
        doc_context: 'general',
        raw_text: null,
        data: {},
      };
      const { error: prescError } = await supabaseAdmin.from('prescriptions').insert(insertPayload);
      if (prescError) {
        console.error(`${LOG_PREFIX_PHOTO}[${traceId}][prescriptions_insert]`, prescError);
        return res.status(500).json({
          ok: false,
          error: 'DB_INSERT_FAILED',
          step: 'prescriptions_insert',
          message: prescError.message ?? null,
          traceId,
        });
      }

      console.log(`${LOG_PREFIX_PHOTO}[${traceId}][prescription_files_insert]`);
      const { data: fileRow, error: fileError } = await supabaseAdmin
        .from('prescription_files')
        .insert({
          prescription_id: prescriptionId,
          profile_id: profileId,
          user_id: userId,
          storage_path: storagePath,
          mime_type: mimetype,
          size_bytes: size,
          original_name: originalname,
          meta: { kind: 'photo', source: 'photo' },
        })
        .select('id')
        .single();

      if (fileError || !fileRow) {
        console.error(`${LOG_PREFIX_PHOTO}[${traceId}][prescription_files_insert]`, fileError);
        await supabaseAdmin.from('prescriptions').update({ status: PrescriptionStatus.ERROR }).eq('id', prescriptionId);
        return res.status(500).json({
          ok: false,
          error: 'DB_INSERT_FAILED',
          step: 'prescription_files_insert',
          message: fileError?.message ?? null,
          traceId,
        });
      }

      return res.status(200).json({
        ok: true,
        prescription_id: prescriptionId,
        file_id: fileRow.id,
        mime_type: mimetype,
        storage_path: storagePath,
        traceId,
        prescriptionId,
        fileId: fileRow.id,
        mimeType: mimetype,
        storagePath: storagePath,
      });
    } catch (err) {
      console.error(`${LOG_PREFIX_PHOTO}[${traceId}][sync_error]`, err);
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : 'Erreur import photo',
          traceId,
        });
      }
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
 * GET /api/prescriptions/:id/preview
 *
 * Auth requireUser. Vérifie owner_user_id/user_id. Dernier fichier (prescription_files order by created_at desc limit 1).
 * bucket = row.storage_bucket ?? row.bucket ?? 'prescriptions', path = row.storage_path ?? row.path.
 * Signed URL 3600s. Réponse: { ok: true, file: { ... }, url } (snake_case + camelCase).
 */
router.get('/:id/preview', requireUser, async (req: Request, res: Response) => {
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
      console.error('[PRESCRIPTIONS] preview load prescription:', prescError);
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

    const { data: fileRow, error: fileError } = await supabaseAdmin
      .from('prescription_files')
      .select('*')
      .eq('prescription_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fileError) {
      console.error('[PRESCRIPTIONS] preview load file:', fileError);
      return res.status(500).json({
        ok: false,
        error: 'DATABASE_ERROR',
        message: 'Erreur lors de la récupération du fichier',
      });
    }

    type FileRow = { storage_path?: string | null; storage_bucket?: string | null; path?: string | null; bucket?: string | null; mime_type?: string | null; id?: string };
    const row = fileRow as FileRow | null;
    const storagePath = (row?.storage_path ?? row?.path ?? '').toString().trim();
    const storageBucket = (row?.storage_bucket ?? row?.bucket ?? BUCKET).toString().trim() || BUCKET;

    if (!storagePath) {
      return res.status(404).json({
        ok: false,
        error: 'FILE_NOT_FOUND',
        message: 'Aucun fichier associé à cette prescription',
      });
    }

    const url = await createSignedUrl({
      bucket: storageBucket,
      path: storagePath,
      expiresIn: 3600,
    });

    const mimeType = row?.mime_type ?? null;
    const fileId = row?.id ?? null;

    return res.status(200).json({
      ok: true,
      url,
      file: {
        file_id: fileId,
        mime_type: mimeType,
        storage_path: storagePath,
        storage_bucket: storageBucket,
        url,
        fileId: fileId,
        mimeType: mimeType,
        storagePath: storagePath,
        storageBucket: storageBucket,
      },
    });
  } catch (err) {
    console.error('[PRESCRIPTIONS] preview error:', err);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : 'Erreur serveur',
    });
  }
});

/**
 * GET /api/prescriptions/:id
 *
 * Auth requireUser. Charge prescription (doit appartenir à req.userId),
 * prescription_files (signedUrl 3600s), prescription_items.
 * Réponse: { ok: true, prescription: { ...prescription, items, files } } (status, raw_text, data, items, files).
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

    const prescriptionPayload = {
      ...prescription,
      items: items ?? [],
      files: filePayload ? [filePayload] : [],
    };

    return res.status(200).json({
      ok: true,
      prescription: prescriptionPayload,
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

/** Valeurs autorisées pour document_kind (classification document) */
const DOCUMENT_KIND_VALUES = ['medicament', 'rdv', 'biologie', 'compte_rendu', 'imagerie', 'certificat', 'autre'] as const;
export type DocumentKindType = (typeof DOCUMENT_KIND_VALUES)[number];

/** Valeurs autorisées pour doc_context */
const DOC_CONTEXT_VALUES = ['general', 'pregnancy', 'child'] as const;
export type DocContextType = (typeof DOC_CONTEXT_VALUES)[number];

function isDocumentKind(v: unknown): v is DocumentKindType {
  return typeof v === 'string' && DOCUMENT_KIND_VALUES.includes(v as DocumentKindType);
}
function isDocContext(v: unknown): v is DocContextType {
  return typeof v === 'string' && DOC_CONTEXT_VALUES.includes(v as DocContextType);
}
function isPregnancyMonth(v: unknown): v is number | null {
  if (v === null || v === undefined) return true;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 9;
}

/**
 * Body JSON pour PATCH /api/prescriptions/:id (écran de vérification)
 */
type PatchPrescriptionBody = {
  status?: PrescriptionStatusType;
  date_ordonnance?: string | null;
  medecin?: { nom?: string | null; prenom?: string | null; rpps?: string | null };
  patient?: { nom?: string | null; prenom?: string | null; date_naissance?: string | null };
  document_kind?: string | null;
  doc_context?: string | null;
  pregnancy_month?: number | null;
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
 * Update prescriptions (status, date_ordonnance, medecin_*, patient_*, document_kind, doc_context, pregnancy_month).
 * document_kind in: medicament, rdv, biologie, compte_rendu, imagerie, certificat, autre.
 * doc_context in: general, pregnancy, child.
 * Upsert items : item.id présent => update, sinon insert ; supprimer les items absents de la liste si items fourni.
 * Retour: { ok: true, prescription } (objet prescription mis à jour).
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

    // Classification document (document_kind, doc_context, pregnancy_month)
    if (body.document_kind !== undefined) {
      if (body.document_kind !== null && body.document_kind !== '' && !isDocumentKind(body.document_kind)) {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: `document_kind doit être l'un de: ${DOCUMENT_KIND_VALUES.join(', ')}`,
        });
      }
      updatePresc.document_kind = body.document_kind === '' ? null : (body.document_kind ?? null);
    }
    if (body.doc_context !== undefined) {
      if (body.doc_context !== null && body.doc_context !== '' && !isDocContext(body.doc_context)) {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: `doc_context doit être l'un de: ${DOC_CONTEXT_VALUES.join(', ')}`,
        });
      }
      updatePresc.doc_context = body.doc_context === '' ? null : (body.doc_context ?? null);
    }
    if (body.pregnancy_month !== undefined) {
      if (!isPregnancyMonth(body.pregnancy_month)) {
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'pregnancy_month doit être null ou un entier entre 1 et 9',
        });
      }
      updatePresc.pregnancy_month = body.pregnancy_month ?? null;
    }

    if (Object.keys(updatePresc).length > 0) {
      if (updatePresc.document_kind !== undefined || updatePresc.doc_context !== undefined || updatePresc.pregnancy_month !== undefined) {
        console.log('[PRESCRIPTIONS] patch classification', { id, document_kind: updatePresc.document_kind, doc_context: updatePresc.doc_context, pregnancy_month: updatePresc.pregnancy_month });
      }
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

    const { data: updatedPrescription, error: fetchError } = await supabaseAdmin
      .from('prescriptions')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !updatedPrescription) {
      console.error('[PRESCRIPTIONS] patch fetch updated:', fetchError);
      return res.status(200).json({ ok: true });
    }
    return res.status(200).json({ ok: true, prescription: updatedPrescription });
  } catch (err) {
    console.error('[PRESCRIPTIONS] patch error:', err);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Erreur serveur',
    });
  }
});

// Erreurs (ex: multer LIMIT_FILE_SIZE) → toujours répondre en JSON, 413 si fichier trop gros.
router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : null;
  console.error('[PRESCRIPTIONS] router error', code, message);
  if (!res.headersSent) {
    const isTooLarge = code === 'LIMIT_FILE_SIZE';
    res.status(isTooLarge ? 413 : 400).json({
      ok: false,
      error: isTooLarge ? 'FILE_TOO_LARGE' : 'ROUTER_ERROR',
      message: isTooLarge ? 'Fichier trop volumineux (max 10 Mo).' : message,
    });
  }
});

export default router;
