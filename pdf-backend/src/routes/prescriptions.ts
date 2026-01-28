/**
 * Routes prescriptions – import ordonnance PDF
 *
 * Tables Supabase:
 * - prescriptions (header, raw_text, statut)
 * - prescription_files (bucket, path, mime, size)
 * - prescription_items (médicaments structurés)
 *
 * Monté sur /api/prescriptions
 */

import express, { Request, Response } from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import { randomUUID } from 'crypto';
import { requireUser } from '../../middlewares/auth.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

const router = express.Router();

const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/pdf';
    cb(null, ok);
  },
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
      .select('id, header, raw_text, statut, created_at')
      .eq('user_id', userId)
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

export default router;
