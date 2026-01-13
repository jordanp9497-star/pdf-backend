# Image de base Python 3.11 slim
FROM python:3.11-slim

# Définir le répertoire de travail
WORKDIR /app

# Installer les dépendances système nécessaires pour OpenCV
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Copier le fichier de dépendances
COPY requirements.txt .

# Installer les dépendances Python
RUN pip install --no-cache-dir -r requirements.txt

# Copier le code de l'application
COPY app.py .

# Exposer le port 8000
EXPOSE 8000

# Commande de démarrage
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
