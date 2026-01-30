# Dossier Data - Index BDPM

Ce dossier contient l'index BDPM généré à partir des fichiers CSV officiels.

## Génération de l'index

Pour générer `bdpm_index.json`, vous devez :

1. **Télécharger les fichiers BDPM** depuis le site officiel ANSM :
   - `CIS_bdpm.csv` : Liste des médicaments (CIS + dénomination)
   - `CIS_COMPO_bdpm.csv` : Compositions (CIS + substances actives)

2. **Placer les fichiers CSV** dans ce dossier ou spécifier leur chemin lors de l'exécution.

3. **Générer l'index** avec la commande :

```bash
npm run build-bdpm-index <chemin-vers-CIS_bdpm.csv> <chemin-vers-CIS_COMPO_bdpm.csv>
```

Exemple :
```bash
npm run build-bdpm-index data/CIS_bdpm.csv data/CIS_COMPO_bdpm.csv
```

Ou avec tsx directement :
```bash
npx tsx scripts/build-bdpm-index.ts data/CIS_bdpm.csv data/CIS_COMPO_bdpm.csv
```

## Format de l'index

Le fichier `bdpm_index.json` contient un tableau d'objets au format :

```json
[
  {
    "cis": "12345678",
    "name": "DOLIPRANE 1000 mg comprimé",
    "substances": ["PARACETAMOL"]
  },
  ...
]
```

- `cis` : Code identifiant de spécialité
- `name` : Dénomination du médicament
- `substances` : Liste des substances actives (normalisées en UPPERCASE)

## Note

Ce fichier n'est pas versionné dans Git (voir `.gitignore`). Il doit être généré localement par chaque développeur.
