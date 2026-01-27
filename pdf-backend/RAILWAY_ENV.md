# Variables d'environnement Railway

## Configuration requise pour POST /ordonnances/:id/recovered

Dans votre projet Railway, ajoutez ces variables dans **Settings > Variables** :

### Variables Supabase (requises)

```bash
SUPABASE_URL=https://paspjmhyndqnatsmcjtu.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
```

**Où trouver SUPABASE_SERVICE_ROLE_KEY ?**

1. Allez sur votre projet Supabase : https://supabase.com/dashboard
2. Sélectionnez votre projet
3. Allez dans **Settings > API**
4. Copiez la clé **service_role** (⚠️ **PAS** la clé anon/public)
   - La clé service_role commence généralement par `sb_secret_` ou `eyJ...`
   - Elle est beaucoup plus longue que la clé anon

**Format de SUPABASE_URL :**
- ✅ Correct : `https://paspjmhyndqnatsmcjtu.supabase.co`
- ❌ Incorrect : `https://paspjmhyndqnatsmcjtu.supabase.co/auth/v1`

### Variables d'authentification (requises pour POST /billing/create-checkout-session)

```bash
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**⚠️ CRITIQUE pour l'authentification :** Cette variable est **OBLIGATOIRE** pour que l'endpoint `/billing/create-checkout-session` fonctionne.

**Où trouver SUPABASE_ANON_KEY ?**

1. Allez sur votre projet Supabase : https://supabase.com/dashboard
2. Sélectionnez votre projet
3. Allez dans **Settings > API**
4. Copiez la clé **anon/public** (celle qui commence par `eyJ...`)
   - C'est la clé publique, différente de la clé service_role
   - Elle est utilisée par le middleware `authenticateSupabase` pour valider les tokens JWT

### Autres variables (déjà configurées)

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...
APP_BASE_URL=https://your-app.railway.app
NODE_ENV=production
PORT=3000
```

## Vérification

Après avoir ajouté les variables :

1. ✅ Redémarrez le service Railway
2. ✅ Vérifiez les logs au démarrage :
   ```
   [ENV] SUPABASE_URL: https://paspjmhyndqnatsmcjtu.supabase.co
   [ENV] SUPABASE_SERVICE_ROLE_KEY present: true (masked: sb_N...xxxx, type: service_role)
   [ENV] SUPABASE_ANON_KEY present: true (masked: eyJh...xxxx, type: anon)
   [SUPABASE] ✅ Client admin initialisé
   ```

3. ✅ Testez l'endpoint avec un token JWT valide

## Schéma de la table `ordonnances`

La table doit avoir au minimum ces colonnes :

```sql
CREATE TABLE ordonnances (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  recovered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  -- autres colonnes...
);
```

**RLS (Row Level Security) :**
- Le client `supabaseAdmin` utilise la clé service_role qui **bypass RLS**
- C'est pourquoi on vérifie manuellement `user_id` dans la requête avec `.eq('user_id', userId)`
