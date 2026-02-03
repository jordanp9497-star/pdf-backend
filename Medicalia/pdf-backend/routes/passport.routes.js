import { Router } from 'express';
import { createHash } from 'crypto';
import { createSignedToken, verifySignedToken } from './qr.routes.js';
import { PUBLIC_WEB_CONFIG } from '../src/config/env.js';

const router = Router();

// ===== PASSPORT SANTE QR API =====
// Stockage temporaire des resumes medicaux (en memoire, indexe par summaryHash)
const passportSummariesStorage = new Map();

// Fonction pour generer un hash simple d'un resume
function generateSummaryHash(personal, summary) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ nom: personal.nom, prenom: personal.prenom, summary }));
  return hash.digest('hex').substring(0, 16); // 16 premiers caracteres
}

// Handler partage pour GET et POST /api/passport/qr
// IMPORTANT: Cette fonction garantit qu'on ne renvoie JAMAIS token:null
function handlePassportQR(req, res) {
  console.log(`[PASSPORT_QR] ${req.method} /api/passport/qr appelée`);

  try {
    // VALIDATION STRICTE: PASSPORT_QR_SECRET est REQUIS
    // Log DEV: verifier si le secret est present
    const hasPassportSecret = !!process.env.PASSPORT_QR_SECRET;
    const hasQrSecret = !!process.env.QR_SECRET;

    console.log(`[PASSPORT_QR] DEV: PASSPORT_QR_SECRET présent: ${hasPassportSecret}, QR_SECRET présent: ${hasQrSecret}`);

    const PASSPORT_SECRET = process.env.PASSPORT_QR_SECRET || process.env.QR_SECRET;

    if (!PASSPORT_SECRET || typeof PASSPORT_SECRET !== 'string' || PASSPORT_SECRET.trim().length === 0) {
      console.error('[PASSPORT_QR] ❌ PASSPORT_SECRET manquant ou invalide');
      console.error('[PASSPORT_QR] ❌ PASSPORT_QR_SECRET:', hasPassportSecret ? 'présent' : 'MANQUANT');
      console.error('[PASSPORT_QR] ❌ QR_SECRET:', hasQrSecret ? 'présent' : 'MANQUANT');

      // IMPORTANT: Ne JAMAIS renvoyer token:null, toujours une erreur
      return res.status(500).json({
        ok: false,
        error: 'PASSPORT_SECRET_MISSING',
        message: 'PASSPORT_QR_SECRET ou QR_SECRET est requis pour générer un token valide'
      });
    }

    // MVP: accepter patientId ou body minimal (personal.nom + summaryHash)
    const patientId = req.query.patientId || req.body?.patientId;
    const personal = req.body?.personal;
    const summaryHash = req.query.summaryHash || req.body?.summaryHash;
    const healthProfile = req.body?.healthProfile; // Optionnel

    // Securite: ne pas logger healthProfile en clair
    const healthProfileHash = healthProfile
      ? createHash('sha256').update(JSON.stringify(healthProfile)).digest('hex').substring(0, 8)
      : null;
    if (healthProfile) {
      console.log(`[PASSPORT_QR] healthProfile reçu (hash: ${healthProfileHash})`);
    }

    // Generer un hash si on a personal + summary
    // IMPORTANT: inclure healthProfile dans le hash pour eviter un mauvais cache
    let hash = summaryHash;
    if (!hash && personal && req.body?.summary) {
      // Construire une cle de cache qui inclut healthProfile (via updatedAt ou hash)
      const cacheKeyParts = [
        personal.nom || '',
        personal.prenom || '',
        req.body.summary
      ];

      // Ajouter healthProfile dans la cle de cache
      if (healthProfile) {
        // Utiliser updatedAt si present, sinon hash du contenu
        const profileKey = healthProfile.updatedAt
          ? healthProfile.updatedAt
          : createHash('sha256').update(JSON.stringify(healthProfile)).digest('hex').substring(0, 16);
        cacheKeyParts.push(profileKey);
      }

      hash = createHash('sha256').update(cacheKeyParts.join('|')).digest('hex').substring(0, 16);

      // Construire le resume enrichi avec healthProfile
      let enrichedSummary = req.body.summary;

      // Ajouter healthProfile au resume si present
      if (healthProfile) {
        const healthParts = [];

        // Allergies
        if (healthProfile.allergies && Array.isArray(healthProfile.allergies) && healthProfile.allergies.length > 0) {
          healthParts.push(`Allergies: ${healthProfile.allergies.join(', ')}`);
        }

        // Maladies chroniques
        if (healthProfile.chronicDiseases && Array.isArray(healthProfile.chronicDiseases) && healthProfile.chronicDiseases.length > 0) {
          healthParts.push(`Maladies chroniques: ${healthProfile.chronicDiseases.join(', ')}`);
        }

        // Traitements au long cours
        if (healthProfile.longTermTreatments && Array.isArray(healthProfile.longTermTreatments) && healthProfile.longTermTreatments.length > 0) {
          const treatments = healthProfile.longTermTreatments.map(t => {
            if (typeof t === 'string') return t;
            if (typeof t === 'object' && t.name) return t.name + (t.dosage ? ` (${t.dosage})` : '');
            return '';
          }).filter(Boolean);
          if (treatments.length > 0) {
            healthParts.push(`Traitements au long cours: ${treatments.join(', ')}`);
          }
        }

        // Contact d'urgence
        if (healthProfile.emergencyContact) {
          const contact = healthProfile.emergencyContact;
          const contactParts = [];
          if (contact.name) contactParts.push(contact.name);
          if (contact.phone) contactParts.push(contact.phone);
          if (contact.relationship) contactParts.push(`(${contact.relationship})`);
          if (contactParts.length > 0) {
            healthParts.push(`Contact d'urgence: ${contactParts.join(' ')}`);
          }
        }

        // Ajouter au resume
        if (healthParts.length > 0) {
          enrichedSummary = enrichedSummary + '\n\n' + healthParts.join('\n');
        }
      }

      // Stocker le resume enrichi pour resolution ulterieure
      passportSummariesStorage.set(hash, {
        summary: enrichedSummary,
        personal,
        healthProfile: healthProfile || null, // Stocker pour reference future
        generatedAt: new Date().toISOString()
      });
    }

    const expiresIn = 30 * 24 * 60 * 60 * 1000; // 30 jours en millisecondes
    const expiresAt = Date.now() + expiresIn;

    // Payload: type + patientId (optionnel) + summaryHash (optionnel) + exp
    const payload = {
      type: 'passport',
      ...(patientId && { patientId }),
      ...(hash && { summaryHash: hash }),
      exp: expiresAt
    };

    // Generer le token signe (version simple qui fonctionnait)
    // IMPORTANT: createSignedToken lance une exception si echec, donc pas besoin de verifier null
    const token = createSignedToken(payload, PASSPORT_SECRET);

    // VALIDATION FINALE: Le token ne doit JAMAIS etre null ou vide
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      console.error('[PASSPORT_QR] ❌ Token généré est null ou vide');
      console.error('[PASSPORT_QR] ❌ Payload:', JSON.stringify(payload));
      console.error('[PASSPORT_QR] ❌ Secret présent:', !!PASSPORT_SECRET);

      // IMPORTANT: Ne JAMAIS renvoyer token:null, toujours une erreur
      return res.status(500).json({
        ok: false,
        error: 'PASSPORT_TOKEN_GENERATION_FAILED',
        message: 'Le token généré est invalide (null ou vide)'
      });
    }

    // Construire le deep link et l'URL web
    const deepLink = `medicalia://passport?t=${token}`;
    const webUrl = `${PUBLIC_WEB_CONFIG.baseUrl}/p/${token}`;

    // Logs DEV utiles (sans exposer le token complet)
    const tokenPrefix = token.length >= 8 ? token.substring(0, 8) + '...' : 'invalid';
    const payloadKeys = Object.keys(payload).join(',');
    console.log(`[PASSPORT_QR] ✅ Token généré avec succès (prefix: ${tokenPrefix}, expiresAt: ${new Date(expiresAt).toISOString()}, payload keys: ${payloadKeys})`);

    // Normaliser la reponse: toujours inclure token (format unique)
    return res.status(200).json({
      ok: true,
      token: token, // TOUJOURS present, jamais null
      expiresAt: new Date(expiresAt).toISOString(),
      deepLink: deepLink,
      webUrl: webUrl,
      qrPayload: deepLink, // Compatibilite (deprecie, utiliser token)
      serverBuild: 'AI_SUMMARY_V2'
    });

  } catch (error) {
    // IMPORTANT: Ne JAMAIS renvoyer token:null, toujours une erreur explicite
    console.error('[PASSPORT_QR] ❌ Erreur critique:', error.message);
    if (error.stack) {
      console.error('[PASSPORT_QR] Stack:', error.stack);
    }

    // Logs DEV: details supplementaires en developpement
    const isDev = process.env.NODE_ENV !== 'production';
    const errorResponse = {
      ok: false,
      error: 'PASSPORT_TOKEN_GENERATION_FAILED',
      message: 'Erreur lors de la génération du token QR Passeport'
    };

    if (isDev) {
      errorResponse.details = error.message;
      errorResponse.stack = error.stack;
    }

    // IMPORTANT: Ne JAMAIS inclure token:null dans la reponse
    return res.status(500).json(errorResponse);
  }
}

// Route GET /api/passport/qr - Generer un token QR pour le Passeport Sante
router.get('/api/passport/qr', handlePassportQR);

// Route POST /api/passport/qr - Generer un token QR pour le Passeport Sante (alias POST)
// Compatibilite: certaines apps peuvent appeler POST au lieu de GET
router.post('/api/passport/qr', handlePassportQR);

// Route GET /api/passport/resolve - Resoudre un token QR Passeport Sante
router.get('/api/passport/resolve', (req, res) => {
  console.log('[PASSPORT_QR] GET /api/passport/resolve appelée');

  try {
    const token = req.query.t;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'TOKEN_MISSING',
        message: 'Le paramètre "t" (token) est requis'
      });
    }

    // Verifier si c'est un mode unsigned
    if (token === 'unsigned' || token.includes('mode=unsigned')) {
      return res.status(200).json({
        ok: false,
        error: 'UNSIGNED_QR',
        message: 'QR non signé. Le secret de signature n\'est pas configuré.'
      });
    }

    // Recuperer le secret
    const PASSPORT_SECRET = process.env.PASSPORT_QR_SECRET || process.env.QR_SECRET;

    if (!PASSPORT_SECRET) {
      return res.status(200).json({
        ok: false,
        error: 'PASSPORT_SECRET_MISSING',
        message: 'QR non signé. Le secret de signature n\'est pas configuré.'
      });
    }

    // Verifier le token
    const result = verifySignedToken(token, PASSPORT_SECRET);

    if (!result.valid) {
      console.log(`[PASSPORT_QR] resolve fail: ${result.error}`);
      return res.status(400).json({
        ok: false,
        error: result.error,
        message: `Token invalide: ${result.error}`
      });
    }

    const payload = result.payload;

    // Verifier que c'est un token passport
    if (payload.type !== 'passport') {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_TOKEN_TYPE',
        message: 'Token non valide pour Passeport Santé'
      });
    }

    // MVP: Recuperer le resume depuis le stockage ou generer un message
    let summary = 'Résumé indisponible';
    let source = 'generated';
    let generatedAt = new Date().toISOString();

    if (payload.summaryHash) {
      const stored = passportSummariesStorage.get(payload.summaryHash);
      if (stored) {
        summary = stored.summary;
        source = 'cache';
        generatedAt = stored.generatedAt;
      }
    }

    console.log(`[PASSPORT_QR] resolve ok: type=${payload.type}, source=${source}`);

    return res.status(200).json({
      ok: true,
      type: 'passport',
      summary,
      source,
      generatedAt
    });

  } catch (error) {
    console.error('[PASSPORT_QR] ❌ Erreur:', error.message);
    if (error.stack) {
      console.error('[PASSPORT_QR] Stack:', error.stack);
    }

    return res.status(500).json({
      ok: false,
      error: 'PASSPORT_RESOLVE_FAILED',
      message: 'Erreur lors de la résolution du token QR Passeport'
    });
  }
});

export default router;
