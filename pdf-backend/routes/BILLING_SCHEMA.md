# Schéma de base de données pour les abonnements Stripe

Ce document décrit les tables Supabase et les variables d'environnement nécessaires pour l'intégration Stripe.

## Variables d'environnement requises

Ajoutez ces variables dans votre fichier `.env` :

```env
# Stripe
STRIPE_SECRET_KEY=sk_test_...  # Clé secrète Stripe (sk_live_... en production)
STRIPE_WEBHOOK_SECRET=whsec_...  # Secret du webhook Stripe (récupéré depuis le dashboard Stripe)
STRIPE_PRICE_ID=price_...  # ID du prix/plan d'abonnement (créé dans Stripe Dashboard)

# Frontend (pour les redirections après checkout)
FRONTEND_URL=https://your-app.com  # URL de votre frontend
# OU
NEXT_PUBLIC_FRONTEND_URL=https://your-app.com  # Alternative pour Next.js

# Supabase (déjà configuré normalement)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key  # Requis pour les opérations backend
```

## Table `subscriptions`

Table pour stocker les abonnements Stripe des utilisateurs.

### Colonnes

```sql
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('incomplete', 'active', 'canceled', 'past_due', 'unpaid')),
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index pour recherche rapide
CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe_customer_id ON subscriptions(stripe_customer_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status) WHERE status = 'active';
```

### Contraintes

- `user_id` : Unique, référence vers `auth.users`
- `stripe_customer_id` : Unique, ID du customer Stripe
- `stripe_subscription_id` : ID de l'abonnement Stripe (peut être NULL si pas encore créé)
- `status` : Statut de l'abonnement (incomplete, active, canceled, past_due, unpaid)
- `current_period_end` : Date de fin de la période d'abonnement actuelle

### Statuts possibles

- `incomplete` : Session de checkout créée mais pas encore complétée
- `active` : Abonnement actif et payé
- `canceled` : Abonnement annulé
- `past_due` : Paiement en retard
- `unpaid` : Paiement échoué

## Configuration Stripe

### 1. Créer un produit et un prix

1. Allez dans Stripe Dashboard > Products
2. Créez un nouveau produit (ex: "Premium Plan")
3. Ajoutez un prix récurrent (monthly/yearly)
4. Copiez le `Price ID` (commence par `price_...`)
5. Ajoutez-le dans `.env` comme `STRIPE_PRICE_ID`

### 2. Configurer le webhook

1. Allez dans Stripe Dashboard > Developers > Webhooks
2. Cliquez sur "Add endpoint"
3. URL: `https://your-backend.com/billing/webhook`
4. Sélectionnez les événements à écouter :
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Copiez le "Signing secret" (commence par `whsec_...`)
6. Ajoutez-le dans `.env` comme `STRIPE_WEBHOOK_SECRET`

### 3. Tester en local avec Stripe CLI

Pour tester les webhooks en local :

```bash
# Installer Stripe CLI
# https://stripe.com/docs/stripe-cli

# Forwarder les webhooks vers votre serveur local
stripe listen --forward-to localhost:3000/billing/webhook

# Le CLI affichera un webhook secret à utiliser temporairement
```

## RLS (Row Level Security)

Assurez-vous que les politiques RLS sont configurées :

```sql
-- Les utilisateurs peuvent voir leur propre abonnement
CREATE POLICY "Users can view their own subscription"
ON subscriptions FOR SELECT
USING (user_id = auth.uid());

-- Les utilisateurs ne peuvent pas modifier leur abonnement directement
-- (seul le webhook Stripe peut le faire)
-- Pas de politique INSERT/UPDATE pour les utilisateurs
```

## Endpoints

### POST /billing/create-checkout-session

Crée une session de checkout Stripe pour l'utilisateur authentifié.

**Headers:**
```
Authorization: Bearer <token>
```

**Réponse:**
```json
{
  "ok": true,
  "url": "https://checkout.stripe.com/..."
}
```

### POST /billing/webhook

Webhook Stripe (pas d'authentification, signature vérifiée).

**Headers:**
```
Stripe-Signature: <signature>
```

Gère automatiquement :
- `checkout.session.completed` : Crée/met à jour l'abonnement
- `customer.subscription.updated` : Met à jour le statut
- `customer.subscription.deleted` : Marque comme annulé

## Helper: isSubscribed(userId)

Fonction helper pour vérifier si un utilisateur a un abonnement actif.

```javascript
import { isSubscribed } from './routes/billing.routes.js';

const subscribed = await isSubscribed(userId);
if (subscribed) {
  // Utilisateur a un abonnement actif
}
```

## Middleware: requireSubscription

Middleware pour protéger les routes premium.

```javascript
import { requireSubscription } from './middlewares/subscription.js';

router.post('/premium-feature',
  authenticateSupabase,
  requireSubscription,
  handler
);
```

## Notes

- Les abonnements sont vérifiés en temps réel (pas de cache)
- La vérification inclut la date d'expiration (`current_period_end`)
- Le webhook met à jour automatiquement les statuts
- En cas d'erreur webhook, Stripe réessaiera automatiquement
