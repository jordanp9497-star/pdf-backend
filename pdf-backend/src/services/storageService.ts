/**
 * Service de stockage Supabase (PDFs / images bruts)
 *
 * Utilise UNIQUEMENT le client Supabase admin (SUPABASE_SERVICE_ROLE_KEY), pas la clé anon.
 * Upload et signed URLs passent par supabaseAdmin => SERVICE_ROLE_KEY.
 * Convention de path: prescriptions/<userId>/<profileId>/<prescriptionId>/<filename>
 * (bucket = "prescriptions", path = "<userId>/<profileId>/<prescriptionId>/<filename>").
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Vérifie que le bucket existe ; le crée si absent (nécessite SERVICE_ROLE_KEY).
 * À appeler au boot ou avant le premier upload.
 */
export async function ensureBucketExists(bucketName: string): Promise<void> {
  const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets();

  if (listError) {
    if (isDev) {
      console.log('[STORAGE] listBuckets error', listError.message);
    }
    throw listError;
  }

  const exists = Array.isArray(buckets) && buckets.some((b) => (b as { name?: string }).name === bucketName);
  if (exists) {
    if (isDev) {
      console.log('[STORAGE] bucket exists', bucketName);
    }
    return;
  }

  const { error: createError } = await supabaseAdmin.storage.createBucket(bucketName, { public: false });
  if (createError) {
    if (isDev) {
      console.log('[STORAGE] createBucket error', bucketName, createError.message);
    }
    throw createError;
  }
  console.log('[STORAGE] bucket created', bucketName);
}

/**
 * Retourne true si l'erreur Storage indique "bucket non trouvé".
 */
export function isBucketNotFoundError(err: unknown): boolean {
  const msg = String((err as Error & { message?: string })?.message ?? '').toLowerCase();
  return msg.includes('bucket') && (msg.includes('not found') || msg.includes('not exist') || msg.includes('missing'));
}

export type UploadBufferOptions = {
  bucket: string;
  path: string;
  buffer: Buffer | Uint8Array;
  contentType: string;
};

/**
 * Upload un buffer dans un bucket Supabase Storage.
 * @returns { path } le path dans le bucket (tel que fourni)
 */
export async function uploadBufferToStorage(
  options: UploadBufferOptions
): Promise<{ path: string }> {
  const { bucket, path, buffer, contentType } = options;

  const { data, error } = await supabaseAdmin.storage.from(bucket).upload(path, buffer, {
    contentType,
    upsert: false,
  });

  if (error) {
    if (isDev) {
      console.log('[STORAGE] upload error', { bucket, path: path.slice(0, 80), code: error.message });
    }
    throw error;
  }

  const resolvedPath = data?.path ?? path;
  if (isDev) {
    console.log('[STORAGE] upload ok', { bucket, path: resolvedPath.slice(0, 80), size: buffer.length });
  }
  return { path: resolvedPath };
}

export type CreateSignedUrlOptions = {
  bucket: string;
  path: string;
  expiresIn: number; // secondes
};

/**
 * Crée une URL signée pour accéder à un fichier (affichage dans l'app).
 * @returns URL signée (time-limited)
 */
export async function createSignedUrl(options: CreateSignedUrlOptions): Promise<string> {
  const { bucket, path, expiresIn } = options;

  const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, expiresIn);

  if (error) {
    if (isDev) {
      console.log('[STORAGE] signed url error', { bucket, path: path.slice(0, 80), code: error.message });
    }
    throw error;
  }

  const url = data?.signedUrl ?? '';
  if (isDev) {
    console.log('[STORAGE] signed url ok', { bucket, path: path.slice(0, 80), expiresIn });
  }
  return url;
}

/**
 * Corrige ".pdf.pdf" en ".pdf" et nettoie les caractères dangereux (espaces, accents, slash).
 * À utiliser pour original_name en DB (affichage).
 */
export function normalizeOriginalFilename(originalName: string): string {
  let name = originalName.trim() || 'document.pdf';
  if (name.toLowerCase().endsWith('.pdf.pdf')) {
    name = name.slice(0, -4);
  }
  name = name.normalize('NFD').replace(/\p{Mark}/gu, '');
  name = name.replace(/[\s/\\]+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
  return name || 'document.pdf';
}

/**
 * Retourne un nom de fichier unique pour le Storage : `${Date.now()}-${random}.pdf`
 */
export function getUniqueStorageFilename(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${random}.pdf`;
}

/**
 * Construit le path Storage pour une ordonnance (convention).
 * Format: <userId>/<profileId>/<prescriptionId>/<filename>
 * Préférer getUniqueStorageFilename() pour le segment filename.
 */
export function buildPrescriptionStoragePath(
  userId: string,
  profileId: string,
  prescriptionId: string,
  filename: string
): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${userId}/${profileId}/${prescriptionId}/${safe}`;
}

/**
 * Path Storage pour prescription_files (NOT NULL).
 * Format: profiles/<profileId>/<prescriptionId>/<timestamp>-<safeName>.pdf
 * Toujours non vide.
 */
export function getPrescriptionFileStoragePath(
  profileId: string,
  prescriptionId: string,
  originalName: string
): string {
  const safe = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.pdf\.pdf$/i, '.pdf') || 'document.pdf';
  const ext = safe.toLowerCase().endsWith('.pdf') ? '' : '.pdf';
  return `profiles/${profileId}/${prescriptionId}/${Date.now()}-${safe}${ext}`;
}

/**
 * Path Storage pour import-photo (image).
 * Format: profiles/{profileId}/prescriptions/{prescriptionId}/{timestamp}_{safeOriginalname}
 * Toujours non vide (prescription_files.storage_path NOT NULL).
 */
export function getPhotoStoragePath(
  profileId: string,
  prescriptionId: string,
  originalName: string
): string {
  let safe = originalName.trim() || 'photo.jpg';
  safe = safe.normalize('NFD').replace(/\p{Mark}/gu, '');
  safe = safe.replace(/[\s/\\]+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_') || 'photo';
  if (!/\.(jpe?g|png|webp)$/i.test(safe)) safe += '.jpg';
  return `profiles/${profileId}/prescriptions/${prescriptionId}/${Date.now()}_${safe}`;
}

/**
 * Chemin Storage DÉTERMINISTE pour import-pdf (pas dépendant de la réponse).
 * Format: ${userId}/${profileId}/${prescriptionId}/${safeFilename}
 * Toujours non vide.
 */
export function getPrescriptionStoragePathDeterministic(
  userId: string,
  profileId: string,
  prescriptionId: string,
  originalName: string
): string {
  let safe = originalName.trim() || 'document.pdf';
  if (safe.toLowerCase().endsWith('.pdf.pdf')) safe = safe.slice(0, -4);
  safe = safe.normalize('NFD').replace(/\p{Mark}/gu, '');
  safe = safe.replace(/[\s/\\]+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_') || 'document';
  if (!safe.toLowerCase().endsWith('.pdf')) safe += '.pdf';
  return `${userId}/${profileId}/${prescriptionId}/${safe}`;
}
