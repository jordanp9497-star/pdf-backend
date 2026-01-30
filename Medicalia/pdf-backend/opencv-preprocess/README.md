# OpenCV Preprocess Service

Microservice FastAPI pour le pré-traitement d'images d'ordonnances médicales avec OpenCV.

## Fonctionnalités

- Reçoit une image en base64 (avec ou sans prefix `data:image`)
- Applique un pré-traitement OpenCV optimisé pour les documents médicaux :
  - Conversion en niveaux de gris
  - Réduction du bruit
  - Amélioration du contraste (CLAHE)
  - Binarisation adaptative
  - Désinclinaison automatique
  - Nettoyage morphologique
- Renvoie l'image pré-traitée en base64 PNG
- Gestion d'erreurs robuste (ne plante jamais)

## Installation

### Avec Docker (recommandé)

```bash
# Construire l'image
docker build -t opencv-preprocess .

# Lancer le conteneur
docker run -p 8000:8000 opencv-preprocess
```

### Sans Docker

```bash
# Installer les dépendances
pip install -r requirements.txt

# Lancer le service
python app.py
```

## Utilisation

### Endpoint de santé

```bash
GET http://localhost:8000/health
```

### Pré-traitement d'image

```bash
POST http://localhost:8000/preprocess
Content-Type: application/json

{
  "base64": "iVBORw0KGgoAAAANSUhEUgAA..."
}
```

**Réponse réussie :**
```json
{
  "success": true,
  "base64": "iVBORw0KGgoAAAANSUhEUgAA...",
  "error": null
}
```

**Réponse d'erreur :**
```json
{
  "success": false,
  "base64": null,
  "error": "INVALID_IMAGE: Impossible de décoder l'image base64"
}
```

## Format de l'image

- **Entrée** : Base64 avec ou sans prefix `data:image/jpeg;base64,`
- **Sortie** : Base64 PNG (sans prefix)

## Pipeline de pré-traitement

1. Décodage base64 → Image OpenCV
2. Conversion en niveaux de gris
3. Réduction du bruit (Gaussian blur)
4. Amélioration du contraste (CLAHE)
5. Binarisation adaptative
6. Désinclinaison automatique
7. Nettoyage morphologique
8. Encodage PNG → Base64

## Technologies

- **FastAPI** : Framework web moderne et performant
- **OpenCV** : Traitement d'images (version headless)
- **NumPy** : Calculs numériques
- **Pydantic** : Validation de données

## Port

Le service écoute sur le port **8000** par défaut.
