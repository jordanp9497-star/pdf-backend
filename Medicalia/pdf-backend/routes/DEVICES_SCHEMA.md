# Schéma de la table `devices`

## Table SQL

```sql
CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  platform TEXT NOT NULL, -- "ios", "android", "web"
  model TEXT, -- "iPhone 14 Pro", "Samsung Galaxy S23", etc.
  app_version TEXT, -- "1.0.0"
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Contrainte: un utilisateur ne peut avoir qu'un seul enregistrement par device_id
  UNIQUE(user_id, device_id)
);

-- Index pour les requêtes fréquentes
CREATE INDEX idx_devices_user_id ON devices(user_id);
CREATE INDEX idx_devices_last_seen ON devices(last_seen_at);
CREATE INDEX idx_devices_user_last_seen ON devices(user_id, last_seen_at);
```

## RLS (Row Level Security)

```sql
-- Désactiver RLS pour cette table (le backend utilise service_role qui bypass RLS)
ALTER TABLE devices DISABLE ROW LEVEL SECURITY;

-- OU activer RLS avec des politiques si nécessaire:
-- ALTER TABLE devices ENABLE ROW LEVEL SECURITY;

-- Politique: les utilisateurs peuvent voir leurs propres appareils
-- CREATE POLICY "Users can view their own devices"
--   ON devices FOR SELECT
--   USING (auth.uid() = user_id);
```

## Endpoints

### POST /devices/heartbeat
- **Auth**: Requis
- **Body**: `{ deviceId: string, platform: string, model?: string, appVersion?: string }`
- **Retour**: `{ ok: true, deviceCount: number }`

## Limites du plan

Les limites sont déterminées par `getPlanLimits()` qui vérifie:
1. `subscriptions.status = 'active'` (priorité)
2. `profiles.is_pro = true` (fallback)

**Limites:**
- Plan gratuit: 2 appareils actifs max
- Plan Pro: 10 appareils actifs max

**Appareil actif:** `last_seen_at` < 7 jours

## Middleware requireEntitlement

Le middleware `requireEntitlement('devices')` vérifie automatiquement:
- Le nombre d'appareils actifs de l'utilisateur
- La limite du plan (gratuit vs Pro)
- Retourne 402 si la limite est dépassée

**Utilisation:**
```javascript
import { requireEntitlement } from '../middlewares/requireEntitlement.js';

router.post('/some-route',
  authenticateSupabase,
  requireEntitlement('devices'),
  handler
);
```
