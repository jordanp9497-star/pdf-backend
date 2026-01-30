/**
 * Script pour construire l'index BDPM à partir des fichiers TXT/CSV
 * 
 * README:
 * Ce script parse les fichiers BDPM (Base de Données Publique des Médicaments)
 * en mode streaming pour construire un index JSON optimisé.
 * 
 * Usage:
 *   tsx scripts/build-bdpm-index.ts --cis ./data/CIS_bdpm.txt --compo ./data/CIS_COMPO_bdpm.txt
 * 
 * Options:
 *   --cis <path>      Chemin vers CIS_bdpm.txt (requis)
 *   --compo <path>    Chemin vers CIS_COMPO_bdpm.txt (requis)
 *   --out <path>      Chemin de sortie (défaut: ./data/bdpm_index.json)
 *   --encoding <enc>  Encodage des fichiers: latin1 ou utf8 (défaut: latin1)
 * 
 * Exemple:
 *   tsx scripts/build-bdpm-index.ts --cis ./data/CIS_bdpm.txt --compo ./data/CIS_COMPO_bdpm.txt --encoding latin1
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface BDPMEntry {
  cis: string;
  name: string;
  substances: string[];
}

interface ColumnIndices {
  cis: number;
  name?: number;
  substance?: number;
}

/**
 * Supprime les accents d'une chaîne
 */
function removeAccents(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Normalise une substance: uppercase, trim, suppression accents
 */
function normalizeSubstance(substance: string): string {
  if (!substance || typeof substance !== 'string') {
    return '';
  }
  return removeAccents(substance.trim().toUpperCase());
}

/**
 * Parse les arguments de ligne de commande
 */
function parseArgs(): {
  cisPath: string;
  compoPath: string;
  outputPath: string;
  encoding: 'latin1' | 'utf8';
} {
  const args = process.argv.slice(2);
  let cisPath: string | null = null;
  let compoPath: string | null = null;
  let outputPath = path.resolve(__dirname, '..', 'data', 'bdpm_index.json');
  let encoding: 'latin1' | 'utf8' = 'latin1';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--cis' && i + 1 < args.length) {
      cisPath = args[++i];
    } else if (arg === '--compo' && i + 1 < args.length) {
      compoPath = args[++i];
    } else if (arg === '--out' && i + 1 < args.length) {
      outputPath = path.resolve(args[++i]);
    } else if (arg === '--encoding' && i + 1 < args.length) {
      const enc = args[++i].toLowerCase();
      if (enc === 'latin1' || enc === 'utf8') {
        encoding = enc;
      } else {
        throw new Error(`Encodage invalide: ${enc}. Utilisez 'latin1' ou 'utf8'`);
      }
    }
  }

  if (!cisPath || !compoPath) {
    throw new Error('❌ Arguments manquants. Utilisez --cis et --compo');
  }

  return {
    cisPath: path.resolve(cisPath),
    compoPath: path.resolve(compoPath),
    outputPath,
    encoding
  };
}

/**
 * Détecte les indices de colonnes dans le header
 */
function detectColumnIndices(
  header: string[],
  type: 'cis' | 'compo'
): ColumnIndices {
  const indices: ColumnIndices = { cis: -1 };

  // Chercher la colonne CIS (case-insensitive)
  for (let i = 0; i < header.length; i++) {
    const col = header[i].toLowerCase();
    if (col.includes('cis')) {
      indices.cis = i;
      break;
    }
  }

  if (indices.cis === -1) {
    throw new Error('❌ Colonne CIS introuvable dans le header');
  }

  if (type === 'cis') {
    // Pour CIS_bdpm: chercher dénomination/libelle/nom
    for (let i = 0; i < header.length; i++) {
      const col = header[i].toLowerCase();
      if (col.includes('denomination') || col.includes('libelle') || col.includes('nom')) {
        indices.name = i;
        break;
      }
    }
    if (indices.name === undefined) {
      throw new Error('❌ Colonne name (dénomination/libellé/nom) introuvable dans CIS_bdpm');
    }
  } else {
    // Pour CIS_COMPO: chercher dénomination/substance/libelle
    for (let i = 0; i < header.length; i++) {
      const col = header[i].toLowerCase();
      if (col.includes('denomination') || col.includes('substance') || col.includes('libelle')) {
        indices.substance = i;
        break;
      }
    }
    if (indices.substance === undefined) {
      throw new Error('❌ Colonne substance (dénomination/substance/libellé) introuvable dans CIS_COMPO_bdpm');
    }
  }

  return indices;
}

/**
 * Parse une ligne CSV (séparateur ;)
 */
function parseCSVLine(line: string): string[] {
  return line.split(';').map(v => {
    let val = v.trim();
    // Retirer les guillemets
    if ((val.startsWith('"') && val.endsWith('"')) || 
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    return val;
  });
}

/**
 * Parse un fichier en streaming et retourne les colonnes détectées + callback pour chaque ligne
 */
async function parseFileStreaming(
  filePath: string,
  encoding: 'latin1' | 'utf8',
  type: 'cis' | 'compo',
  onData: (values: string[], indices: ColumnIndices) => void
): Promise<ColumnIndices> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      reject(new Error(`❌ Fichier introuvable: ${filePath}`));
      return;
    }

    const fileStream = fs.createReadStream(filePath, { encoding });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let lineNumber = 0;
    let columnIndices: ColumnIndices | null = null;

    rl.on('line', (line) => {
      lineNumber++;

      // Ignorer les lignes vides
      if (!line.trim()) {
        return;
      }

      const values = parseCSVLine(line);

      // Première ligne = header
      if (lineNumber === 1) {
        try {
          columnIndices = detectColumnIndices(values, type);
        } catch (error) {
          rl.close();
          reject(error);
          return;
        }
        return;
      }

      // Vérifier que le header a été lu
      if (!columnIndices) {
        return;
      }

      // Appeler le callback avec la ligne parsée
      onData(values, columnIndices);
    });

    rl.on('close', () => {
      if (!columnIndices) {
        reject(new Error('❌ Header non trouvé dans le fichier'));
      } else {
        resolve(columnIndices);
      }
    });

    rl.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Fonction principale
 */
async function main() {
  try {
    const { cisPath, compoPath, outputPath, encoding } = parseArgs();

    console.log('🔨 Construction de l\'index BDPM...');
    console.log(`   CIS_bdpm: ${cisPath}`);
    console.log(`   CIS_COMPO: ${compoPath}`);
    console.log(`   Encodage: ${encoding}`);
    console.log(`   Sortie: ${outputPath}`);

    // Map pour stocker les données: CIS -> { cis, name, substances: Set }
    const indexMap = new Map<string, { cis: string; name: string; substances: Set<string> }>();

    // 1. Parse CIS_bdpm.txt
    console.log('\n📋 Étape 1: Parsing CIS_bdpm.txt...');
    let cisCount = 0;
    let cisWithoutName = 0;
    let cisInvalid = 0;

    await parseFileStreaming(cisPath, encoding, 'cis', (values, indices) => {
      const cis = values[indices.cis]?.trim();
      const name = indices.name !== undefined ? values[indices.name]?.trim() : '';

      // Ignorer les lignes avec CIS vide
      if (!cis) {
        cisInvalid++;
        return;
      }

      if (!name) {
        cisWithoutName++;
        return;
      }

      if (!indexMap.has(cis)) {
        indexMap.set(cis, {
          cis,
          name,
          substances: new Set()
        });
        cisCount++;
      } else {
        // Mettre à jour le nom si nécessaire
        const entry = indexMap.get(cis)!;
        if (!entry.name && name) {
          entry.name = name;
        }
      }
    });

    console.log(`   ✅ ${cisCount} médicaments indexés`);
    if (cisWithoutName > 0) {
      console.log(`   ⚠️  ${cisWithoutName} CIS sans nom ignorés`);
    }
    if (cisInvalid > 0) {
      console.log(`   ⚠️  ${cisInvalid} lignes avec CIS vide ignorées`);
    }

    // 2. Parse CIS_COMPO_bdpm.txt
    console.log('\n🧪 Étape 2: Parsing CIS_COMPO_bdpm.txt...');
    let compoCount = 0;
    let compoWithoutSubstance = 0;
    let compoInvalid = 0;

    await parseFileStreaming(compoPath, encoding, 'compo', (values, indices) => {
      const cis = values[indices.cis]?.trim();
      const substance = indices.substance !== undefined
        ? values[indices.substance]?.trim()
        : '';

      // Ignorer les lignes avec CIS vide
      if (!cis) {
        compoInvalid++;
        return;
      }

      if (!substance) {
        compoWithoutSubstance++;
        return;
      }

      const normalizedSubstance = normalizeSubstance(substance);
      if (!normalizedSubstance) {
        compoWithoutSubstance++;
        return;
      }

      // Ajouter la substance si le CIS existe dans l'index
      if (indexMap.has(cis)) {
        indexMap.get(cis)!.substances.add(normalizedSubstance);
        compoCount++;
      }
      // Si le CIS n'existe pas dans l'index, on l'ignore (pas de nom dans CIS_bdpm)
    });

    console.log(`   ✅ ${compoCount} substances ajoutées`);
    if (compoWithoutSubstance > 0) {
      console.log(`   ⚠️  ${compoWithoutSubstance} lignes sans substance valide ignorées`);
    }
    if (compoInvalid > 0) {
      console.log(`   ⚠️  ${compoInvalid} lignes avec CIS vide ignorées`);
    }

    // 3. Construire l'index final
    console.log('\n🔗 Étape 3: Construction de l\'index final...');
    const index: BDPMEntry[] = [];
    let cisWithoutSubstances = 0;

    for (const entry of indexMap.values()) {
      if (entry.substances.size > 0) {
        index.push({
          cis: entry.cis,
          name: entry.name,
          substances: Array.from(entry.substances).sort()
        });
      } else {
        cisWithoutSubstances++;
      }
    }

    console.log(`   ✅ ${index.length} entrées avec substances actives`);
    if (cisWithoutSubstances > 0) {
      console.log(`   ⚠️  ${cisWithoutSubstances} CIS sans substances`);
    }

    // 4. Sauvegarder
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
      console.log(`   📁 Dossier créé: ${outputDir}`);
    }

    fs.writeFileSync(outputPath, JSON.stringify(index, null, 2), 'utf-8');

    console.log(`\n✅ Index généré avec succès!`);
    console.log(`   📄 Fichier: ${outputPath}`);
    console.log(`   📊 Total: ${index.length} médicaments`);
    
    // Statistiques
    const totalSubstances = index.reduce((sum, entry) => sum + entry.substances.length, 0);
    const avgSubstances = index.length > 0 
      ? (totalSubstances / index.length).toFixed(2)
      : '0';
    console.log(`   🧪 Substances actives: ${totalSubstances} (moyenne: ${avgSubstances}/médicament)`);

  } catch (error) {
    console.error('\n❌ Erreur:', error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
