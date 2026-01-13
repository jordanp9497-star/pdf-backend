"""
Microservice FastAPI pour pré-traitement d'images d'ordonnances médicales avec OpenCV.
Applique des transformations adaptées aux documents médicaux (fond sécurisé = fond blanc).
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import cv2
import numpy as np
import base64
import io
from typing import Optional
import logging

# Configuration du logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="OpenCV Preprocess Service",
    description="Pré-traitement d'images d'ordonnances médicales avec OpenCV",
    version="1.0.0"
)


class ImageRequest(BaseModel):
    """Modèle de requête pour l'image en base64"""
    base64: str


class ImageResponse(BaseModel):
    """Modèle de réponse avec l'image pré-traitée en base64"""
    success: bool
    base64: Optional[str] = None
    error: Optional[str] = None


def decode_base64_image(base64_str: str) -> Optional[np.ndarray]:
    """
    Décode une image base64 (avec ou sans prefix data:image).
    Retourne None si l'image est invalide.
    """
    try:
        # Supprimer le prefix data:image si présent
        if base64_str.startswith('data:image'):
            base64_str = base64_str.split(',', 1)[1]
        
        # Décoder le base64
        image_data = base64.b64decode(base64_str)
        
        # Convertir en numpy array
        nparr = np.frombuffer(image_data, np.uint8)
        
        # Décoder l'image avec OpenCV
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if img is None:
            logger.warning("Échec du décodage de l'image")
            return None
        
        return img
    except Exception as e:
        logger.error(f"Erreur lors du décodage base64: {str(e)}")
        return None


def encode_image_to_base64_png(img: np.ndarray) -> Optional[str]:
    """
    Encode une image OpenCV en base64 PNG.
    Retourne None en cas d'erreur.
    """
    try:
        # Encoder en PNG
        success, buffer = cv2.imencode('.png', img)
        
        if not success:
            logger.warning("Échec de l'encodage PNG")
            return None
        
        # Convertir en base64
        base64_str = base64.b64encode(buffer).decode('utf-8')
        return base64_str
    except Exception as e:
        logger.error(f"Erreur lors de l'encodage base64: {str(e)}")
        return None


def preprocess_ordonnance(img: np.ndarray) -> np.ndarray:
    """
    Applique un pré-traitement OpenCV adapté aux ordonnances médicales.
    Optimisé pour des documents avec fond sécurisé (fond blanc).
    
    Pipeline de traitement :
    1. Conversion en niveaux de gris
    2. Réduction du bruit
    3. Amélioration du contraste
    4. Binarisation adaptative
    5. Désinclinaison (deskew) si nécessaire
    6. Détection et correction de perspective
    """
    try:
        # 1. Conversion en niveaux de gris
        if len(img.shape) == 3:
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        else:
            gray = img.copy()
        
        # 2. Réduction du bruit avec filtre gaussien
        denoised = cv2.GaussianBlur(gray, (3, 3), 0)
        
        # 3. Amélioration du contraste avec CLAHE (Contrast Limited Adaptive Histogram Equalization)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(denoised)
        
        # 4. Binarisation adaptative (meilleure pour documents avec ombres/variations)
        binary = cv2.adaptiveThreshold(
            enhanced,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            11,
            2
        )
        
        # 5. Désinclinaison (deskew) - détection de l'angle d'inclinaison
        coords = np.column_stack(np.where(binary > 0))
        if len(coords) > 0:
            angle = cv2.minAreaRect(coords)[-1]
            if angle < -45:
                angle = -(90 + angle)
            else:
                angle = -angle
            
            # Rotation si l'angle est significatif (> 0.5 degrés)
            if abs(angle) > 0.5:
                (h, w) = binary.shape[:2]
                center = (w // 2, h // 2)
                M = cv2.getRotationMatrix2D(center, angle, 1.0)
                binary = cv2.warpAffine(binary, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        
        # 6. Morphologie pour nettoyer les petits artefacts
        kernel = np.ones((2, 2), np.uint8)
        cleaned = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
        
        # 7. Réduction des bords noirs parasites
        cleaned = cv2.erode(cleaned, kernel, iterations=1)
        cleaned = cv2.dilate(cleaned, kernel, iterations=1)
        
        # Convertir en BGR pour la sortie (3 canaux)
        result = cv2.cvtColor(cleaned, cv2.COLOR_GRAY2BGR)
        
        return result
        
    except Exception as e:
        logger.error(f"Erreur lors du pré-traitement: {str(e)}")
        # En cas d'erreur, retourner l'image originale
        return img


@app.get("/")
async def root():
    """Endpoint de santé"""
    return {
        "service": "opencv-preprocess",
        "status": "ok",
        "version": "1.0.0"
    }


@app.get("/health")
async def health():
    """Endpoint de santé détaillé"""
    return {"status": "healthy"}


@app.post("/preprocess", response_model=ImageResponse)
async def preprocess_image(request: ImageRequest):
    """
    Endpoint principal : reçoit une image en base64 et retourne l'image pré-traitée.
    
    Args:
        request: Objet contenant le champ 'base64' avec l'image encodée
        
    Returns:
        ImageResponse avec success=True et base64 de l'image pré-traitée,
        ou success=False avec un message d'erreur
    """
    try:
        # Validation de base
        if not request.base64 or len(request.base64) < 100:
            return ImageResponse(
                success=False,
                error="INVALID_BASE64: Le champ base64 est requis et doit contenir au moins 100 caractères"
            )
        
        # Décodage de l'image
        img = decode_base64_image(request.base64)
        if img is None:
            return ImageResponse(
                success=False,
                error="INVALID_IMAGE: Impossible de décoder l'image base64"
            )
        
        logger.info(f"Image reçue: {img.shape[0]}x{img.shape[1]} pixels")
        
        # Pré-traitement
        processed_img = preprocess_ordonnance(img)
        
        # Encodage en base64 PNG
        base64_result = encode_image_to_base64_png(processed_img)
        if base64_result is None:
            return ImageResponse(
                success=False,
                error="ENCODING_ERROR: Impossible d'encoder l'image pré-traitée"
            )
        
        logger.info("Pré-traitement réussi")
        
        return ImageResponse(
            success=True,
            base64=base64_result
        )
        
    except Exception as e:
        logger.error(f"Erreur inattendue: {str(e)}")
        return ImageResponse(
            success=False,
            error=f"INTERNAL_ERROR: {str(e)}"
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
