/**
 * Routes pour la gestion des abonnements Stripe
 *
 * GET /billing/plans - Liste des plans visibles (premium_monthly 4,99€, premium_annual 49,99€)
 * GET /billing/me - Entitlements / premium (plan, pregnancy_pack_enabled)
 * POST /billing/create-checkout-session - Créer une session de checkout Stripe
 * POST /billing/webhook - Webhook Stripe pour mettre à jour les abonnements
 */

import express from 'express';
import { authenticateSupabase } from '../middlewares/auth.js';
import { stripe } from '../src/lib/stripe.js';
import { supabaseAdmin } from '../src/lib/supabaseAdmin.js';
import { STRIPE_CONFIG, APP_CONFIG } from '../src/config/env.js';
import { getPlanLimits } from '../src/lib/planLimits.js';
import { isFeatureEnabled } from '../src/services/features.js';

const router = express.Router();

// Utiliser les clients centralisés
const supabase = supabaseAdmin;

// Plans visibles dans le menu abonnements (exclut l'ancien plan 2,99€)
const VISIBLE_PLAN_IDS = ['premium_monthly', 'premium_annual'];

// Price ID Premium hardcodé (sécurité: jamais accepté depuis le client)
const PREMIUM_PRICE_ID = 'price_1SsTI3L9JokDSsqLuZralNuv';

/**
 * GET /billing/plans
 *
 * Retourne les 2 plans visibles: premium_monthly (4,99€), premium_annual (49,99€).
 * Champs exposés: id, display_name, monthly_price_cents, annual_price_cents, highlight, features.
 * Tri: highlight desc, puis prix (monthly_price_cents).
 */
router.get('/plans', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        ok: false,
        error: 'CONFIG_ERROR',
        message: 'Configuration Supabase manquante',
      });
    }
    const { data: plans, error } = await supabase
      .from('subscription_plans')
      .select('id, display_name, monthly_price_cents, annual_price_cents, highlight, features')
      .in('id', VISIBLE_PLAN_IDS)
      .order('highlight', { ascending: false })
      .order('monthly_price_cents', { ascending: true });

    if (error) {
      console.error('[BILLING] GET /plans error:', error);
      return res.status(500).json({
        ok: false,
        error: 'DATABASE_ERROR',
        message: error.message ?? 'Erreur lors de la récupération des plans',
      });
    }

    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.status(200).json({
      ok: true,
      plans: plans ?? [],
    });
  } catch (err) {
    console.error('[BILLING] GET /plans error:', err);
    res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Erreur serveur',
    });
  }
});

/**
 * Helper: Vérifie si un utilisateur est abonné (actif)
 * 
 * @param {string} userId - ID de l'utilisateur
 * @returns {Promise<boolean>} - true si l'utilisateur a un abonnement actif
 */
/**
 * GET /billing/me
 *
 * Retourne entitlements / premium pour l'utilisateur authentifié.
 * pregnancy_pack_enabled = (entitlement normal isPro) OR feature override 'pregnancy_pack'.
 */
router.get('/me', authenticateSupabase, async (req, res) => {
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: 'Authentification requise',
      });
    }
    const limits = await getPlanLimits(userId);
    const overridePregnancy = await isFeatureEnabled(userId, 'pregnancy_pack');
    const pregnancy_pack_enabled = limits.isPro || overridePregnancy;

    if (overridePregnancy && process.env.NODE_ENV !== 'production') {
      console.log('[BILLING] pregnancy_pack override enabled');
    }

    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.status(200).json({
      ok: true,
      plan: limits.isPro ? 'PREMIUM' : 'FREE',
      isPro: limits.isPro,
      pregnancy_pack_enabled,
    });
  } catch (err) {
    console.error('[BILLING] GET /me error:', err);
    res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Erreur serveur',
    });
  }
});

export async function isSubscribed(userId) {
  if (!supabase || !userId) {
    return false;
  }

  try {
    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select('id, status, current_period_end')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    if (error || !subscription) {
      return false;
    }

    // Vérifier que l'abonnement n'est pas expiré
    const now = new Date();
    const periodEnd = new Date(subscription.current_period_end);

    return periodEnd > now;
  } catch (error) {
    console.error('[BILLING] Erreur lors de la vérification de l\'abonnement:', error);
    return false;
  }
}

/**
 * POST /billing/create-checkout-session
 * 
 * Crée une session de checkout Stripe pour l'abonnement Premium
 * - Requiert authentification (ou fallback x-user-id en dev)
 * - Refuse tout priceId venant du client (sécurité)
 * - Utilise uniquement le Price ID Premium hardcodé
 * - Retourne l'URL de checkout
 * 
 * Retourne: { url: string }
 */
router.post('/create-checkout-session',
  authenticateSupabase,
  async (req, res) => {
    try {
      // Sécurité: Refuser tout priceId venant du client
      if (req.body && req.body.priceId) {
        console.log('[BILLING] ⚠️ Tentative d\'injection de priceId depuis le client, ignoré');
        return res.status(400).json({
          ok: false,
          error: 'BAD_REQUEST',
          message: 'priceId not allowed - Le Price ID est géré côté serveur'
        });
      }

      // Récupérer userId: req.user.id (auth) > x-user-id (dev fallback) > "anonymous"
      let userId = null;
      if (req.user && req.user.id) {
        userId = req.user.id;
      } else if (req.headers['x-user-id']) {
        userId = req.headers['x-user-id'];
        console.log('[BILLING] ⚠️ Utilisation de x-user-id header (dev fallback)');
      } else {
        userId = 'anonymous';
      }

      console.log('[BILLING] create-checkout-session', { 
        userId, 
        hasAppBaseUrl: !!APP_CONFIG.baseUrl 
      });

      if (!supabase) {
        return res.status(500).json({
          ok: false,
          error: 'CONFIG_ERROR',
          message: 'Configuration Supabase manquante'
        });
      }

      // Récupérer ou créer le customer Stripe (uniquement si userId n'est pas "anonymous")
      let stripeCustomerId = null;

      if (userId !== 'anonymous') {
        // Vérifier si l'utilisateur a déjà un customer Stripe
        const { data: existingSubscription } = await supabase
          .from('subscriptions')
          .select('stripe_customer_id')
          .eq('user_id', userId)
          .single();

        if (existingSubscription?.stripe_customer_id) {
          stripeCustomerId = existingSubscription.stripe_customer_id;
        } else {
          // Créer un nouveau customer Stripe
          const customer = await stripe.customers.create({
            metadata: {
              userId: userId
            }
          });

          stripeCustomerId = customer.id;

          // Créer une entrée dans subscriptions (sans abonnement actif pour l'instant)
          await supabase
            .from('subscriptions')
            .upsert({
              user_id: userId,
              stripe_customer_id: stripeCustomerId,
              status: 'incomplete',
              updated_at: new Date().toISOString()
            }, {
              onConflict: 'user_id'
            });
        }
      } else {
        // Pour les utilisateurs anonymes, créer un customer temporaire sans l'enregistrer en DB
        const customer = await stripe.customers.create({
          metadata: {
            userId: 'anonymous'
          }
        });
        stripeCustomerId = customer.id;
      }

      // Créer la session de checkout avec le Price ID Premium hardcodé
      const session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        payment_method_types: ['card'],
        line_items: [
          {
            price: PREMIUM_PRICE_ID, // Price ID Premium hardcodé (sécurité)
            quantity: 1
          }
        ],
        mode: 'subscription',
        success_url: `${APP_CONFIG.baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_CONFIG.baseUrl}/billing/cancel`,
        client_reference_id: userId !== 'anonymous' ? userId : undefined,
        metadata: {
          userId: userId
        }
      });

      // Vérifier que l'URL de session est présente
      if (!session.url) {
        console.error('[BILLING] ❌ Session créée mais URL manquante', { sessionId: session.id });
        return res.status(500).json({
          ok: false,
          error: 'STRIPE_ERROR',
          message: 'Erreur: URL de session Stripe manquante'
        });
      }

      console.log('[BILLING] created session', { id: session.id, userId });

      return res.status(200).json({
        ok: true,
        url: session.url
      });

    } catch (error) {
      console.error('[BILLING] ❌ Erreur lors de la création de la session:', error);
      return res.status(500).json({
        ok: false,
        error: 'STRIPE_ERROR',
        message: error.message || 'Erreur lors de la création de la session de checkout'
      });
    }
  }
);

/**
 * Handler pour le webhook Stripe
 * 
 * Webhook Stripe pour mettre à jour les abonnements
 * - Pas d'authentification (signature Stripe vérifiée)
 * - Gère les événements: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted
 * 
 * NOTE: Le body parser raw est appliqué dans index.js AVANT express.json()
 * Cette fonction est exportée pour être utilisée directement dans index.js
 */
export async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];

  if (!stripe) {
    console.error('[BILLING] ❌ Stripe non configuré');
    return res.status(500).json({ error: 'Configuration manquante' });
  }

  let event;

  try {
    // Vérifier la signature du webhook
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_CONFIG.webhookSecret);
  } catch (err) {
    console.error('[BILLING] ❌ Erreur de signature webhook:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (!supabase) {
    console.error('[BILLING] ❌ Supabase non configuré');
    return res.status(500).json({ error: 'Configuration Supabase manquante' });
  }

  try {
    // Gérer les différents types d'événements
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId || session.customer;

        console.log(`[BILLING] 📝 checkout.session.completed pour utilisateur ${userId}`);

        // Récupérer l'abonnement créé
        const subscription = await stripe.subscriptions.retrieve(session.subscription);

        // Mettre à jour ou créer l'entrée dans subscriptions
        await supabase
          .from('subscriptions')
          .upsert({
            user_id: userId,
            stripe_customer_id: session.customer,
            stripe_subscription_id: subscription.id,
            status: subscription.status,
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'user_id'
          });

        console.log(`[BILLING] ✅ Abonnement créé pour utilisateur ${userId}`);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        console.log(`[BILLING] 📝 customer.subscription.updated pour customer ${customerId}`);

        // Récupérer l'user_id depuis subscriptions
        const { data: sub } = await supabase
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', customerId)
          .single();

        if (sub) {
          await supabase
            .from('subscriptions')
            .update({
              stripe_subscription_id: subscription.id,
              status: subscription.status,
              current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('user_id', sub.user_id);

          console.log(`[BILLING] ✅ Abonnement mis à jour pour utilisateur ${sub.user_id}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        console.log(`[BILLING] 📝 customer.subscription.deleted pour customer ${customerId}`);

        // Récupérer l'user_id depuis subscriptions
        const { data: sub } = await supabase
          .from('subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', customerId)
          .single();

        if (sub) {
          await supabase
            .from('subscriptions')
            .update({
              status: 'canceled',
              updated_at: new Date().toISOString()
            })
            .eq('user_id', sub.user_id);

          console.log(`[BILLING] ✅ Abonnement annulé pour utilisateur ${sub.user_id}`);
        }
        break;
      }

      default:
        console.log(`[BILLING] ⚠️ Événement non géré: ${event.type}`);
    }

    // Répondre rapidement à Stripe
    res.json({ received: true });

  } catch (error) {
    console.error('[BILLING] ❌ Erreur lors du traitement du webhook:', error);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
}

/**
 * GET /billing/success
 * 
 * Endpoint de redirection après succès du checkout Stripe
 * Retourne simplement un statut OK
 */
router.get('/success', (req, res) => {
  const sessionId = req.query.session_id;
  console.log('[BILLING] ✅ Redirect success', { sessionId });
  res.status(200).send('OK');
});

/**
 * GET /billing/cancel
 * 
 * Endpoint de redirection après annulation du checkout Stripe
 * Retourne simplement un statut CANCELED
 */
router.get('/cancel', (req, res) => {
  console.log('[BILLING] ❌ Redirect cancel');
  res.status(200).send('CANCELED');
});

// Les fonctions isSubscribed et handleStripeWebhook sont déjà exportées individuellement ci-dessus

export default router;
