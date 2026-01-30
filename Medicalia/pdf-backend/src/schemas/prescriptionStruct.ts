/**
 * Schéma Zod pour la structuration ordonnance (OpenAI → JSON strict).
 * Ne rien inventer : null si absent.
 */

import { z } from 'zod';

const nullableString = z.string().nullable().optional().transform((v) => v ?? null);

export const PrescriptionItemSchema = z.object({
  nom: nullableString,
  dosage: nullableString,
  forme: nullableString,
  frequence_par_jour: nullableString,
  moment: nullableString,
  duree: nullableString,
  instructions: nullableString,
});

export const PrescriptionMedecinSchema = z.object({
  nom: nullableString,
  prenom: nullableString,
  rpps: nullableString,
});

export const PrescriptionPatientSchema = z.object({
  nom: nullableString,
  prenom: nullableString,
  date_naissance: nullableString,
});

export const PrescriptionStructSchema = z.object({
  date_ordonnance: nullableString,
  medecin: PrescriptionMedecinSchema.nullable().optional(),
  patient: PrescriptionPatientSchema.nullable().optional(),
  items: z.array(PrescriptionItemSchema).optional().default([]),
});

export type PrescriptionStruct = z.infer<typeof PrescriptionStructSchema>;
export type PrescriptionItem = z.infer<typeof PrescriptionItemSchema>;

const FALLBACK_STRUCT: PrescriptionStruct = {
  date_ordonnance: null,
  medecin: null,
  patient: null,
  items: [],
};

/**
 * Parse le JSON brut (réponse OpenAI) avec Zod.
 * En cas d'échec : retourne header null + items [].
 */
export function parsePrescriptionStruct(raw: unknown): PrescriptionStruct {
  const parsed = PrescriptionStructSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return FALLBACK_STRUCT;
}
