# PDF Backend

Backend Node.js minimal pour extraire le texte d'un PDF.

## Installation

```bash
npm install
```

## Démarrage

```bash
npm start
```

Le serveur démarre sur le port 3000 par défaut (ou le port défini dans la variable d'environnement `PORT`).

## Routes

### POST /extract
Route pour extraire le texte d'un PDF (à implémenter).

### GET /health
Route de santé pour vérifier que le serveur est actif.

## Développement

Le projet est prêt à être étendu avec une bibliothèque d'extraction PDF (comme `pdf-parse` ou `pdfjs-dist`).

