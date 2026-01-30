/**
 * Service de structuration d'ordonnance via OpenAI.
 * Produit un JSON strict, validé par Zod ; fallback header null + items [] si invalide.
 */

import OpenAI from 'openai';
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
  const { openaiApiKey, rawText } = options;
  const client = new OpenAI({ apiKey: openaiApiKey });

  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Texte de l'ordonnance:\n\n${rawText.slice(0, 12000)}` },
    ],
    response_format: { type: 'json_object' },
  });

  const content = completion.choices[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    return parsePrescriptionStruct(null);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return parsePrescriptionStruct(null);
  }
  return parsePrescriptionStruct(raw);
}
