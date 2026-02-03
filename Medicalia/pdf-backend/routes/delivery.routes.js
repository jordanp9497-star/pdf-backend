import { Router } from 'express';
import { randomUUID } from 'crypto';

const router = Router();

// ===== DELIVERY ORDERS API =====
// Stockage temporaire des commandes de livraison (en memoire)
// TODO: Migrer vers une base de donnees persistante (PostgreSQL/MongoDB)
const deliveryOrdersStorage = new Map();

// Statuts valides pour une commande de livraison
const VALID_DELIVERY_STATUSES = ['PENDING', 'ACCEPTED', 'PICKED_UP'];

// Validation du body pour creer une commande de livraison
function validateCreateDeliveryOrderBody(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'BODY_MISSING', message: 'Le body de la requête est manquant' };
  }

  if (!body.ordonnanceId || typeof body.ordonnanceId !== 'string' || body.ordonnanceId.trim() === '') {
    return { valid: false, error: 'ORDONNANCE_ID_MISSING', message: 'ordonnanceId est requis et doit être une chaîne non vide' };
  }

  if (!body.pharmacyId || typeof body.pharmacyId !== 'string' || body.pharmacyId.trim() === '') {
    return { valid: false, error: 'PHARMACY_ID_MISSING', message: 'pharmacyId est requis et doit être une chaîne non vide' };
  }

  if (!body.deliveryAddress || typeof body.deliveryAddress !== 'string' || body.deliveryAddress.trim() === '') {
    return { valid: false, error: 'DELIVERY_ADDRESS_MISSING', message: 'deliveryAddress est requis et doit être une chaîne non vide' };
  }

  // Champs optionnels
  if (body.deliveryNote !== undefined && typeof body.deliveryNote !== 'string') {
    return { valid: false, error: 'INVALID_DELIVERY_NOTE', message: 'deliveryNote doit être une chaîne ou null' };
  }

  if (body.patientPhone !== undefined && typeof body.patientPhone !== 'string') {
    return { valid: false, error: 'INVALID_PATIENT_PHONE', message: 'patientPhone doit être une chaîne ou null' };
  }

  if (body.timeWindow !== undefined && typeof body.timeWindow !== 'string') {
    return { valid: false, error: 'INVALID_TIME_WINDOW', message: 'timeWindow doit être une chaîne ou null' };
  }

  return { valid: true };
}

// Validation du body pour mettre a jour le statut
function validateUpdateStatusBody(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'BODY_MISSING', message: 'Le body de la requête est manquant' };
  }

  if (!body.status || typeof body.status !== 'string') {
    return { valid: false, error: 'STATUS_MISSING', message: 'status est requis et doit être une chaîne' };
  }

  if (!VALID_DELIVERY_STATUSES.includes(body.status)) {
    return {
      valid: false,
      error: 'INVALID_STATUS',
      message: `status doit être l'un des suivants: ${VALID_DELIVERY_STATUSES.join(', ')}`
    };
  }

  return { valid: true };
}

// Fonction pour creer un objet DeliveryOrder
function createDeliveryOrder(data) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +24h

  return {
    id: randomUUID(),
    ordonnanceId: data.ordonnanceId,
    pharmacyId: data.pharmacyId,
    status: 'PENDING',
    deliveryAddress: data.deliveryAddress,
    deliveryNote: data.deliveryNote || null,
    patientPhone: data.patientPhone || null,
    timeWindow: data.timeWindow || null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
}

// Fonction pour nettoyer les donnees sensibles avant de renvoyer une commande
// SECURITE: Ne jamais exposer le contenu de l'ordonnance ni le QR
function sanitizeDeliveryOrder(order) {
  if (!order) return null;

  return {
    id: order.id,
    ordonnanceId: order.ordonnanceId,
    pharmacyId: order.pharmacyId,
    status: order.status,
    deliveryAddress: order.deliveryAddress,
    deliveryNote: order.deliveryNote,
    patientPhone: order.patientPhone,
    timeWindow: order.timeWindow,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    expiresAt: order.expiresAt
    // NOTE: Pas de contenu ordonnance, pas de QR, pas de donnees medicales
  };
}

// Placeholder pour notifier la pharmacie
function notifyPharmacy(order) {
  console.log('[DELIVERY] 📧 Notifier pharmacie:', {
    orderId: order.id,
    pharmacyId: order.pharmacyId,
    status: order.status,
    // TODO: Implementer notification Twilio/FCM/SMS
  });
}

// Placeholder pour notifier le pool de livreurs
function notifyCourierPool(order) {
  console.log('[DELIVERY] 🚚 Notifier pool de livreurs:', {
    orderId: order.id,
    pharmacyId: order.pharmacyId,
    deliveryAddress: order.deliveryAddress,
    status: order.status,
    // TODO: Implementer notification FCM/Push pour livreurs
  });
}

// Route POST /delivery/orders - Creer une commande de livraison
router.post('/delivery/orders', (req, res) => {
  console.log('[DELIVERY] POST /delivery/orders appelée');

  try {
    // Validation
    const validation = validateCreateDeliveryOrderBody(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        ok: false,
        error: validation.error,
        message: validation.message
      });
    }

    // Creer la commande
    const order = createDeliveryOrder({
      ordonnanceId: req.body.ordonnanceId.trim(),
      pharmacyId: req.body.pharmacyId.trim(),
      deliveryAddress: req.body.deliveryAddress.trim(),
      deliveryNote: req.body.deliveryNote?.trim() || null,
      patientPhone: req.body.patientPhone?.trim() || null,
      timeWindow: req.body.timeWindow?.trim() || null
    });

    // Stocker en memoire
    deliveryOrdersStorage.set(order.id, order);

    console.log(`[DELIVERY] ✅ Commande créée: ${order.id} (total: ${deliveryOrdersStorage.size})`);

    // Notifier la pharmacie (placeholder)
    notifyPharmacy(order);

    // Retourner la reponse (sans donnees sensibles)
    return res.status(200).json({
      ok: true,
      order: sanitizeDeliveryOrder(order)
    });

  } catch (error) {
    console.error('[DELIVERY] ❌ Erreur:', error.message);
    if (error.stack) {
      console.error('[DELIVERY] Stack:', error.stack);
    }

    return res.status(500).json({
      ok: false,
      error: 'DELIVERY_ORDER_CREATION_FAILED',
      message: 'Erreur lors de la création de la commande de livraison'
    });
  }
});

// Route GET /delivery/orders/:id - Lire une commande
router.get('/delivery/orders/:id', (req, res) => {
  console.log('[DELIVERY] GET /delivery/orders/:id appelée');

  try {
    const orderId = req.params.id;

    if (!orderId || typeof orderId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_ORDER_ID',
        message: 'ID de commande invalide'
      });
    }

    const order = deliveryOrdersStorage.get(orderId);

    if (!order) {
      return res.status(404).json({
        ok: false,
        error: 'ORDER_NOT_FOUND',
        message: 'Commande non trouvée'
      });
    }

    // Retourner la commande (sans donnees sensibles)
    return res.status(200).json({
      ok: true,
      order: sanitizeDeliveryOrder(order)
    });

  } catch (error) {
    console.error('[DELIVERY] ❌ Erreur:', error.message);
    if (error.stack) {
      console.error('[DELIVERY] Stack:', error.stack);
    }

    return res.status(500).json({
      ok: false,
      error: 'DELIVERY_ORDER_FETCH_FAILED',
      message: 'Erreur lors de la récupération de la commande'
    });
  }
});

// Route GET /delivery/orders?ordonnanceId=... - Lister les commandes d'une ordonnance
router.get('/delivery/orders', (req, res) => {
  console.log('[DELIVERY] GET /delivery/orders appelée');

  try {
    const ordonnanceId = req.query.ordonnanceId;

    if (!ordonnanceId || typeof ordonnanceId !== 'string' || ordonnanceId.trim() === '') {
      return res.status(400).json({
        ok: false,
        error: 'ORDONNANCE_ID_MISSING',
        message: 'Le paramètre ordonnanceId est requis'
      });
    }

    // Filtrer les commandes par ordonnanceId
    const orders = Array.from(deliveryOrdersStorage.values())
      .filter(order => order.ordonnanceId === ordonnanceId.trim())
      .map(order => sanitizeDeliveryOrder(order));

    return res.status(200).json({
      ok: true,
      orders,
      count: orders.length
    });

  } catch (error) {
    console.error('[DELIVERY] ❌ Erreur:', error.message);
    if (error.stack) {
      console.error('[DELIVERY] Stack:', error.stack);
    }

    return res.status(500).json({
      ok: false,
      error: 'DELIVERY_ORDERS_FETCH_FAILED',
      message: 'Erreur lors de la récupération des commandes'
    });
  }
});

// Route PATCH /delivery/orders/:id/status - Mettre a jour le statut (pour tests/admin)
router.patch('/delivery/orders/:id/status', (req, res) => {
  console.log('[DELIVERY] PATCH /delivery/orders/:id/status appelée');

  try {
    const orderId = req.params.id;

    if (!orderId || typeof orderId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_ORDER_ID',
        message: 'ID de commande invalide'
      });
    }

    // Validation du body
    const validation = validateUpdateStatusBody(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        ok: false,
        error: validation.error,
        message: validation.message
      });
    }

    const order = deliveryOrdersStorage.get(orderId);

    if (!order) {
      return res.status(404).json({
        ok: false,
        error: 'ORDER_NOT_FOUND',
        message: 'Commande non trouvée'
      });
    }

    // Mettre a jour le statut
    const oldStatus = order.status;
    order.status = req.body.status;
    order.updatedAt = new Date().toISOString();

    // Mettre a jour le stockage
    deliveryOrdersStorage.set(orderId, order);

    console.log(`[DELIVERY] ✅ Statut mis à jour: ${orderId} ${oldStatus} → ${order.status}`);

    // Notifier selon le nouveau statut
    if (order.status === 'ACCEPTED') {
      notifyCourierPool(order);
    }

    // Retourner la commande mise a jour (sans donnees sensibles)
    return res.status(200).json({
      ok: true,
      order: sanitizeDeliveryOrder(order)
    });

  } catch (error) {
    console.error('[DELIVERY] ❌ Erreur:', error.message);
    if (error.stack) {
      console.error('[DELIVERY] Stack:', error.stack);
    }

    return res.status(500).json({
      ok: false,
      error: 'DELIVERY_ORDER_UPDATE_FAILED',
      message: 'Erreur lors de la mise à jour du statut de la commande'
    });
  }
});

export default router;
