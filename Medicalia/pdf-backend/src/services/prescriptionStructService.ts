/**
 * Service de structuration d'ordonnance.
 * OpenAI désactivé: retourne un fallback validé (aucune donnée structurée).
 */
import { parsePrescriptionStruct, type PrescriptionStruct } from '../schemas/prescriptionStruct.js';

const SYSTEM_PROMPT = `Tu es un assistant médical. À partir du texte d'une ordonnance française, extrais UNIQUEMENT les informations présentes. Ne jamais inventer.

RÈGLES STRICTES:
- Ne jamais inventer d'information. Si une information est absente, mets null.
- Retourne UNIQUEMENT un JSON valide, sans markdown, sans commentaire.
- Pour les médicaments (items), un champ = une info présente dans le texte ; null si absent.

FORMAT OBLIGATOIRE (respecte exactement les clés):
{
  "date_ordonnance": "YYYY-MM-DD ou null",
  "medecin": { "nom": "string ou null", "prenom": "string ou null", "rpps": "string ou null" },
  "patient": { "nom": "string ou null", "prenom": "string ou null", "date_naissance": "string ou null" },
  "items": [
    { "nom": "string ou null", "dosage": "string ou null", "forme": "string ou null", "frequence_par_jour": "string ou null", "moment": "string ou null", "duree": "string ou null", "instructions": "string ou null" }
  ]
}`;

export type StructOptions = {
  openaiApiKey: string;
  rawText: string;
};

/**
 * Appelle OpenAI pour structurer le texte d'ordonnance.
 * Retourne un objet validé par Zod ; en échec de parsing/validation : fallback (date_ordonnance null, medecin null, patient null, items []).
 */
export async function structurizePrescriptionText(
  options: StructOptions
): Promise<PrescriptionStruct> {
  void options;
  return parsePrescriptionStruct(null);
}
