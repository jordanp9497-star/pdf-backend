/**
 * Service de stockage Supabase (PDFs / images bruts)
 *
 * Utilise le client Supabase avec SERVICE_ROLE_KEY (upload + signed URLs).
 * Convention de path: prescriptions/<userId>/<profileId>/<prescriptionId>/<filename>
 * (bucket = "prescriptions", path = "<userId>/<profileId>/<prescriptionId>/<filename>").
 */

import { supabaseAdmin } from '../lib/supabaseAdmin.js';

const isDev = process.env.NODE_ENV !== 'production';

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
 * Construit le path Storage pour une ordonnance (convention).
 * Format: <userId>/<profileId>/<prescriptionId>/<filename>
 * Bucket attendu: "prescriptions"
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
