import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

/**
 * Interface pour les entrées de l'index BDPM
 */
let bdpmIndex = [];

/**
 * Charge l'index BDPM au démarrage
 */
function loadBDPMIndex() {
  try {
    const indexPath = path.join(__dirname, '..', 'data', 'bdpm_index.json');
    
    if (!fs.existsSync(indexPath)) {
      console.warn(`[MEDS] ⚠️ Index BDPM introuvable: ${indexPath}`);
      console.warn(`[MEDS] L'endpoint /meds/resolve-substances ne fonctionnera pas sans l'index.`);
      console.warn(`[MEDS] Exécutez: tsx scripts/build-bdpm-index.ts <CIS_bdpm.csv> <CIS_COMPO_bdpm.csv>`);
      bdpmIndex = [];
      return;
    }

    const content = fs.readFileSync(indexPath, 'utf-8');
    bdpmIndex = JSON.parse(content);
    console.log(`[MEDS] ✅ Index BDPM chargé: ${bdpmIndex.length} médicaments`);
  } catch (error) {
    console.error(`[MEDS] ❌ Erreur lors du chargement de l'index BDPM:`, error.message);
    bdpmIndex = [];
  }
}

/**
 * Normalise un nom de médicament pour la recherche (uppercase, trim)
 */
function normalizeSearchName(name) {
  if (!name || typeof name !== 'string') {
    return '';
  }
  return name.trim().toUpperCase();
}

/**
 * Recherche fuzzy simple: startsWith ou contains
 */
function searchMeds(query) {
  if (!bdpmIndex || bdpmIndex.length === 0) {
    return [];
  }

  const normalizedQuery = normalizeSearchName(query);
  if (!normalizedQuery) {
    return [];
  }

  // Recherche: startsWith en priorité, puis contains
  const startsWithMatches = [];
  const containsMatches = [];

  for (const entry of bdpmIndex) {
    const normalizedName = normalizeSearchName(entry.name);
    
    if (normalizedName.startsWith(normalizedQuery)) {
      startsWithMatches.push(entry);
    } else if (normalizedName.includes(normalizedQuery)) {
      containsMatches.push(entry);
    }
  }

  // Retourner startsWith en premier, puis contains (limité à 10 résultats)
  const results = [...startsWithMatches, ...containsMatches].slice(0, 10);
  return results;
}

/**
 * POST /meds/resolve-substances
 * 
 * Entrée: { name: string }
 * Sortie: { normalizedName: string, substances: string[] }
 */
router.post('/resolve-substances', (req, res) => {
  console.log(`[MEDS] POST /resolve-substances - name: "${req.body?.name}"`);

  // Vérification du body
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_BODY',
      message: 'Body doit être un objet JSON'
    });
  }

  // Vérification du champ name
  if (!req.body.name || typeof req.body.name !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_BODY',
      message: 'Le champ "name" (string) est requis'
    });
  }

  // Vérifier que l'index est chargé
  if (!bdpmIndex || bdpmIndex.length === 0) {
    return res.status(503).json({
      ok: false,
      error: 'INDEX_NOT_LOADED',
      message: 'Index BDPM non chargé. Vérifiez que data/bdpm_index.json existe.'
    });
  }

  // Recherche fuzzy
  const matches = searchMeds(req.body.name);

  if (matches.length === 0) {
    return res.status(200).json({
      ok: true,
      normalizedName: normalizeSearchName(req.body.name),
      substances: []
    });
  }

  // Prendre le premier résultat (meilleur match)
  const bestMatch = matches[0];

  // Retourner les substances normalisées (déjà en uppercase dans l'index)
  return res.status(200).json({
    ok: true,
    normalizedName: bestMatch.name.toUpperCase(),
    substances: bestMatch.substances || []
  });
});

// Charger l'index au chargement du module
loadBDPMIndex();

export default router;
