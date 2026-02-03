import { Router } from 'express';
import { createHmac } from 'crypto';
import { PUBLIC_WEB_CONFIG } from '../src/config/env.js';

const router = Router();

// ===== QR CODE API (Token signe pour ordonnances) =====
// Fonction generique pour creer un token signe
function createSignedToken(payload, secret) {
  // VALIDATION: payload et secret doivent etre valides
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload invalide: doit être un objet');
  }

  if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
    throw new Error('Secret invalide: doit être une chaîne non vide');
  }

  // Encoder le payload en base64url
  let payloadBase64;
  try {
    payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  } catch (error) {
    throw new Error(`Erreur lors de l'encodage du payload: ${error.message}`);
  }

  if (!payloadBase64 || payloadBase64.length === 0) {
    throw new Error('Payload encodé est vide');
  }

  // Generer la signature HMAC
  const hmac = createHmac('sha256', secret);
  hmac.update(payloadBase64);
  const signature = hmac.digest('base64url');

  if (!signature || signature.length === 0) {
    throw new Error('Signature générée est vide');
  }

  // Token = payload.signature
  const token = `${payloadBase64}.${signature}`;

  // VALIDATION: Le token final ne doit jamais etre vide
  if (!token || token.length === 0) {
    throw new Error('Token généré est vide');
  }

  return token;
}

// Fonction generique pour verifier un token signe
function verifySignedToken(token, secret) {
  try {
    // Separer payload et signature
    const [payloadBase64, signature] = token.split('.');
    if (!payloadBase64 || !signature) {
      return { valid: false, error: 'INVALID_TOKEN_FORMAT' };
    }

    // Verifier la signature
    const hmac = createHmac('sha256', secret);
    hmac.update(payloadBase64);
    const expectedSignature = hmac.digest('base64url');

    if (signature !== expectedSignature) {
      return { valid: false, error: 'INVALID_SIGNATURE' };
    }

    // Decoder le payload
    const payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8'));

    // Verifier l'expiration
    if (payload.exp && Date.now() > payload.exp) {
      return { valid: false, error: 'TOKEN_EXPIRED' };
    }

    return { valid: true, payload };
  } catch (error) {
    return { valid: false, error: 'TOKEN_PARSE_ERROR' };
  }
}

// Genere un token signe pour une ordonnance
function generateQRToken(ordonnanceId) {
  const QR_SECRET = process.env.QR_SECRET || 'default-secret-change-in-production';
  const expiresIn = 7 * 24 * 60 * 60 * 1000; // 7 jours en millisecondes
  const expiresAt = Date.now() + expiresIn;

  // Payload: id + exp (pas de donnees medicales)
  const payload = {
    id: ordonnanceId,
    exp: expiresAt
  };

  const token = createSignedToken(payload, QR_SECRET);

  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

// Verifie et resout un token QR
function verifyQRToken(token) {
  const QR_SECRET = process.env.QR_SECRET || 'default-secret-change-in-production';
  const result = verifySignedToken(token, QR_SECRET);

  if (!result.valid) {
    return result;
  }

  return { valid: true, ordonnanceId: result.payload.id };
}

// Route GET /api/ordonnances/:id/qr - Generer un token QR pour une ordonnance
router.get('/api/ordonnances/:id/qr', (req, res) => {
  console.log('[QR] GET /api/ordonnances/:id/qr appelée');

  try {
    const ordonnanceId = req.params.id;

    if (!ordonnanceId || typeof ordonnanceId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_ORDONNANCE_ID',
        message: 'ID d\'ordonnance invalide'
      });
    }

    // Generer le token signe
    const { token, expiresAt } = generateQRToken(ordonnanceId);

    // Base URL web (depuis config centralisée)
    const PUBLIC_WEB_BASE_URL = PUBLIC_WEB_CONFIG.baseUrl;

    // Construire le deep link et l'URL web
    const deepLink = `medicalia://ordonnance/${ordonnanceId}?t=${token}`;
    const webUrl = `${PUBLIC_WEB_BASE_URL}/o/${token}`;

    // qrPayload pointe vers webUrl par defaut (scannable universellement)
    const qrPayload = webUrl;

    console.log(`[QR] ✅ Token généré pour ordonnance: ${ordonnanceId}`);

    return res.status(200).json({
      ok: true,
      ordonnanceId,
      qrPayload,
      qrData: qrPayload, // Alias pour compatibilite frontend
      webUrl,
      deepLink,
      expiresAt
    });

  } catch (error) {
    console.error('[QR] ❌ Erreur:', error.message);
    if (error.stack) {
      console.error('[QR] Stack:', error.stack);
    }

    return res.status(500).json({
      ok: false,
      error: 'QR_GENERATION_FAILED',
      message: 'Erreur lors de la génération du token QR'
    });
  }
});

// Route GET /api/qr/resolve - Resoudre un token QR
router.get('/api/qr/resolve', (req, res) => {
  console.log('[QR] GET /api/qr/resolve appelée');

  try {
    const token = req.query.t;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'TOKEN_MISSING',
        message: 'Le paramètre "t" (token) est requis'
      });
    }

    // Verifier le token
    const result = verifyQRToken(token);

    if (!result.valid) {
      return res.status(400).json({
        ok: false,
        error: result.error,
        message: `Token invalide: ${result.error}`
      });
    }

    console.log(`[QR] ✅ Token résolu: ordonnanceId=${result.ordonnanceId}`);

    return res.status(200).json({
      ok: true,
      ordonnanceId: result.ordonnanceId
    });

  } catch (error) {
    console.error('[QR] ❌ Erreur:', error.message);
    if (error.stack) {
      console.error('[QR] Stack:', error.stack);
    }

    return res.status(500).json({
      ok: false,
      error: 'QR_RESOLVE_FAILED',
      message: 'Erreur lors de la résolution du token QR'
    });
  }
});

// ===== WEB QR PAGES (Mini site pour scans QR universels) =====

// Helper: Detecter le type d'appareil depuis user-agent
function detectDevice(userAgent) {
  if (!userAgent) return 'desktop';

  const ua = userAgent.toLowerCase();

  if (/iphone|ipad|ipod/.test(ua)) {
    return 'ios';
  }

  if (/android/.test(ua)) {
    return 'android';
  }

  return 'desktop';
}

// Helper: Generer le lien store selon l'appareil
function getStoreLink(device) {
  // TODO: Remplacer par les vrais liens App Store / Play Store quand disponibles
  const STORE_LINKS = {
    ios: 'https://apps.apple.com/app/medicalia', // TODO: Lien App Store reel
    android: 'https://play.google.com/store/apps/details?id=com.medicalia.app', // TODO: Lien Play Store reel
    desktop: null // Pas de store sur desktop
  };

  return STORE_LINKS[device] || null;
}

// Helper: Generer le HTML de la page QR
function generateQRPageHTML(options) {
  const {
    title,
    subtitle,
    icon,
    deepLink,
    storeLink,
    device,
    tokenPrefix
  } = options;

  const hasStoreLink = storeLink !== null;
  const storeButtonHTML = hasStoreLink
    ? `<a href="${storeLink}" class="store-button" target="_blank" rel="noopener noreferrer">Installer l'app</a>`
    : '<p class="info-text">Installez l\'app Medicalia depuis l\'App Store ou Google Play.</p>';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate, proxy-revalidate">
  <meta http-equiv="Pragma" content="no-cache">
  <meta http-equiv="Expires" content="0">
  <title>${title} - Medicalia</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 20px;
      padding: 40px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      text-align: center;
    }
    .logo {
      font-size: 48px;
      margin-bottom: 20px;
    }
    h1 {
      color: #333;
      font-size: 28px;
      margin-bottom: 10px;
      font-weight: 600;
    }
    .subtitle {
      color: #666;
      font-size: 16px;
      margin-bottom: 30px;
      line-height: 1.5;
    }
    .app-button {
      display: inline-block;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 16px 32px;
      border-radius: 12px;
      text-decoration: none;
      font-size: 18px;
      font-weight: 600;
      margin: 10px 0;
      transition: transform 0.2s, box-shadow 0.2s;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
      width: 100%;
      max-width: 280px;
    }
    .app-button:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5);
    }
    .app-button:active {
      transform: translateY(0);
    }
    .store-button {
      display: inline-block;
      background: #f5f5f5;
      color: #333;
      padding: 12px 24px;
      border-radius: 12px;
      text-decoration: none;
      font-size: 16px;
      font-weight: 500;
      margin: 10px 0;
      transition: background 0.2s;
      width: 100%;
      max-width: 280px;
    }
    .store-button:hover {
      background: #e0e0e0;
    }
    .info-text {
      color: #888;
      font-size: 14px;
      margin-top: 20px;
      line-height: 1.6;
    }
    .warning {
      background: #fff3cd;
      border-left: 4px solid #ffc107;
      padding: 12px;
      margin-top: 20px;
      border-radius: 8px;
      font-size: 13px;
      color: #856404;
      text-align: left;
    }
    .warning strong {
      display: block;
      margin-bottom: 4px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">${icon}</div>
    <h1>${title}</h1>
    <p class="subtitle">${subtitle}</p>
    <a href="${deepLink}" class="app-button" id="appButton">Ouvrir dans Medicalia</a>
    ${hasStoreLink ? storeButtonHTML : ''}
    <div class="warning">
      <strong>⚠️ Sécurité</strong>
      Ne donnez pas ce QR code à n'importe qui. Il contient des informations médicales confidentielles.
    </div>
  </div>
  <script>
    // Tentative d'ouverture automatique de l'app (une seule fois, sans boucle)
    (function() {
      var attempted = false;
      var deepLink = "${deepLink}";

      // Tentative apres 500ms
      setTimeout(function() {
        if (!attempted) {
          attempted = true;
          window.location.href = deepLink;

          // Si apres 2s on est toujours sur la page, l'app n'est probablement pas installee
          setTimeout(function() {
            // Ne rien faire, laisser l'utilisateur cliquer manuellement
          }, 2000);
        }
      }, 500);

      // Fallback: si l'utilisateur clique sur le bouton, on tente a nouveau
      document.getElementById('appButton').addEventListener('click', function(e) {
        if (!attempted) {
          attempted = true;
        }
      });
    })();
  </script>
</body>
</html>`;
}

// Helper: Generer le HTML d'erreur
function generateErrorHTML(message) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate">
  <title>Erreur - Medicalia</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      text-align: center;
      padding: 40px 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 20px;
      max-width: 400px;
    }
    h1 { color: #333; margin-bottom: 10px; }
    p { color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Erreur</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

// Route GET /o/:token - Page web pour QR code ordonnance
router.get('/o/:token', (req, res) => {
  // Log leger: seulement le prefixe du token (premiers 8 caracteres)
  const token = req.params.token;
  const tokenPrefix = token && token.length >= 8 ? token.substring(0, 8) + '...' : 'invalid';
  console.log(`[QR_WEB] GET /o/:token appelée (token: ${tokenPrefix})`);

  // Headers de securite
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });

  try {
    if (!token || typeof token !== 'string' || token.trim() === '') {
      return res.status(400).send(generateErrorHTML('Token invalide'));
    }

    // Detecter l'appareil
    const userAgent = req.get('user-agent') || '';
    const device = detectDevice(userAgent);
    const storeLink = getStoreLink(device);

    // Deep link: medicalia://o/<token>
    const deepLink = `medicalia://o/${token}`;

    // Generer le HTML
    const html = generateQRPageHTML({
      title: 'Ordonnance Medicalia',
      subtitle: 'Accédez à votre ordonnance médicale en toute sécurité',
      icon: '🏥',
      deepLink,
      storeLink,
      device,
      tokenPrefix
    });

    res.status(200).send(html);

  } catch (error) {
    console.error('[QR_WEB] ❌ Erreur /o/:token:', error.message);
    res.status(500).send(generateErrorHTML('Une erreur est survenue lors du chargement de la page.'));
  }
});

// Route GET /p/:token - Page web pour QR code Passeport Sante
router.get('/p/:token', (req, res) => {
  // Log leger: seulement le prefixe du token (premiers 8 caracteres)
  const token = req.params.token;
  const tokenPrefix = token && token.length >= 8 ? token.substring(0, 8) + '...' : 'invalid';
  console.log(`[QR_WEB] GET /p/:token appelée (token: ${tokenPrefix})`);

  // Headers de securite
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });

  try {
    if (!token || typeof token !== 'string' || token.trim() === '') {
      return res.status(400).send(generateErrorHTML('Token invalide'));
    }

    // Detecter l'appareil
    const userAgent = req.get('user-agent') || '';
    const device = detectDevice(userAgent);
    const storeLink = getStoreLink(device);

    // Deep link: medicalia://p/<token>
    const deepLink = `medicalia://p/${token}`;

    // Generer le HTML
    const html = generateQRPageHTML({
      title: 'Passeport Santé Medicalia',
      subtitle: 'Accédez à votre résumé médical en toute sécurité',
      icon: '📋',
      deepLink,
      storeLink,
      device,
      tokenPrefix
    });

    res.status(200).send(html);

  } catch (error) {
    console.error('[QR_WEB] ❌ Erreur /p/:token:', error.message);
    res.status(500).send(generateErrorHTML('Une erreur est survenue lors du chargement de la page.'));
  }
});

// Route GET /open/o/:token - Redirection directe vers deep link (sans JS)
// But: Faciliter le bouton "Ouvrir" sans JavaScript
// Comportement:
// - Par defaut: redirige (302) vers medicalia://o/<token>
// - Si ?fallback=1: redirige vers le store (App Store/Play Store) selon l'appareil
// - Si deep link echoue: l'utilisateur reste sur la page d'origine ou est redirige vers le store
router.get('/open/o/:token', (req, res) => {
  // Log leger: seulement le prefixe du token
  const token = req.params.token;
  const tokenPrefix = token && token.length >= 8 ? token.substring(0, 8) + '...' : 'invalid';
  const fallback = req.query.fallback === '1';
  console.log(`[QR_WEB] GET /open/o/:token appelée (token: ${tokenPrefix}, fallback: ${fallback})`);

  try {
    if (!token || typeof token !== 'string' || token.trim() === '') {
      return res.status(400).send(generateErrorHTML('Token invalide'));
    }

    // Si fallback=1, rediriger vers le store
    if (fallback) {
      const userAgent = req.get('user-agent') || '';
      const device = detectDevice(userAgent);
      const storeLink = getStoreLink(device);

      if (storeLink) {
        return res.redirect(302, storeLink);
      } else {
        // Pas de store disponible (desktop), rediriger vers la page HTML
        return res.redirect(302, `/o/${token}`);
      }
    }

    // Par defaut: rediriger vers le deep link
    const deepLink = `medicalia://o/${token}`;
    res.redirect(302, deepLink);

  } catch (error) {
    console.error('[QR_WEB] ❌ Erreur /open/o/:token:', error.message);
    // En cas d'erreur, rediriger vers la page HTML
    res.redirect(302, `/o/${token}`);
  }
});

// Route GET /open/p/:token - Redirection directe vers deep link (sans JS)
// But: Faciliter le bouton "Ouvrir" sans JavaScript
// Comportement:
// - Par defaut: redirige (302) vers medicalia://p/<token>
// - Si ?fallback=1: redirige vers le store (App Store/Play Store) selon l'appareil
// - Si deep link echoue: l'utilisateur reste sur la page d'origine ou est redirige vers le store
router.get('/open/p/:token', (req, res) => {
  // Log leger: seulement le prefixe du token
  const token = req.params.token;
  const tokenPrefix = token && token.length >= 8 ? token.substring(0, 8) + '...' : 'invalid';
  const fallback = req.query.fallback === '1';
  console.log(`[QR_WEB] GET /open/p/:token appelée (token: ${tokenPrefix}, fallback: ${fallback})`);

  try {
    if (!token || typeof token !== 'string' || token.trim() === '') {
      return res.status(400).send(generateErrorHTML('Token invalide'));
    }

    // Si fallback=1, rediriger vers le store
    if (fallback) {
      const userAgent = req.get('user-agent') || '';
      const device = detectDevice(userAgent);
      const storeLink = getStoreLink(device);

      if (storeLink) {
        return res.redirect(302, storeLink);
      } else {
        // Pas de store disponible (desktop), rediriger vers la page HTML
        return res.redirect(302, `/p/${token}`);
      }
    }

    // Par defaut: rediriger vers le deep link
    const deepLink = `medicalia://p/${token}`;
    res.redirect(302, deepLink);

  } catch (error) {
    console.error('[QR_WEB] ❌ Erreur /open/p/:token:', error.message);
    // En cas d'erreur, rediriger vers la page HTML
    res.redirect(302, `/p/${token}`);
  }
});

// Export helpers for use by passport routes
export { createSignedToken, verifySignedToken };

export default router;
