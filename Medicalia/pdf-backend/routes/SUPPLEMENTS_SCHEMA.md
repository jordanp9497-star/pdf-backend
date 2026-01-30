# Schéma de la table `supplements`

## Structure de la table

```sql
CREATE TABLE supplements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  schedule JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index pour améliorer les performances
CREATE INDEX idx_supplements_owner_user_id ON supplements(owner_user_id);
CREATE INDEX idx_supplements_profile_id ON supplements(profile_id);
CREATE INDEX idx_supplements_status ON supplements(status);
CREATE INDEX idx_supplements_created_at ON supplements(created_at DESC);

-- RLS (Row Level Security) - Optionnel si on utilise service_role
-- ALTER TABLE supplements ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY supplements_owner_policy ON supplements
--   USING (owner_user_id = auth.uid());
```

## Champs

- **id** : UUID unique (généré automatiquement)
- **owner_user_id** : UUID de l'utilisateur propriétaire (référence vers `auth.users`)
- **profile_id** : UUID du profil (optionnel, référence vers `profiles`)
- **title** : Titre du complément (requis)
- **notes** : Notes additionnelles (optionnel)
- **status** : Statut du complément (`active` ou `inactive`, défaut: `active`)
- **start_date** : Date de début (optionnel, TIMESTAMPTZ)
- **end_date** : Date de fin (optionnel, TIMESTAMPTZ)
- **schedule** : Planning de prise (JSONB, optionnel)
- **created_at** : Date de création (TIMESTAMPTZ)
- **updated_at** : Date de dernière mise à jour (TIMESTAMPTZ)

## Format du champ `schedule` (JSONB)

Le champ `schedule` est un objet JSON avec la structure suivante :

### Mode `daily` (quotidien)
```json
{
  "mode": "daily",
  "times": ["08:00", "20:00"]
}
```

### Mode `weekly` (hebdomadaire)
```json
{
  "mode": "weekly",
  "times": ["08:00"],
  "daysOfWeek": [1, 3, 5]  // 0=dimanche, 1=lundi, ..., 6=samedi
}
```

### Mode `monthly` (mensuel)
```json
{
  "mode": "monthly",
  "times": ["08:00"],
  "dayOfMonth": 15  // Jour du mois (1-31)
}
```

### Validation

- **times** : Tableau non vide de strings au format `HH:mm` (ex: `"08:00"`, `"20:30"`)
- **mode** : Doit être `"daily"`, `"weekly"` ou `"monthly"`
- **daysOfWeek** : Requis si `mode="weekly"`, tableau de nombres entre 0 (dimanche) et 6 (samedi)
- **dayOfMonth** : Requis si `mode="monthly"`, nombre entre 1 et 31

## Endpoints API

### GET /supplements?profile_id=...

Liste les compléments de l'utilisateur authentifié.

- **Auth** : Requis (Bearer token)
- **Query params** :
  - `profile_id` (optionnel) : UUID du profil pour filtrer
- **Tri** : Actifs d'abord (`status='active'`), puis `created_at DESC`
- **Sécurité** : Filtre automatique par `owner_user_id = user.id`

**Réponse 200** :
```json
{
  "ok": true,
  "supplements": [
    {
      "id": "uuid",
      "owner_user_id": "uuid",
      "profile_id": "uuid",
      "title": "Vitamine D",
      "notes": "Prendre avec un repas",
      "status": "active",
      "start_date": "2025-01-01T00:00:00Z",
      "end_date": null,
      "schedule": {
        "mode": "daily",
        "times": ["08:00"]
      },
      "created_at": "2025-01-01T00:00:00Z",
      "updated_at": "2025-01-01T00:00:00Z"
    }
  ]
}
```

### POST /supplements

Crée un nouveau complément.

- **Auth** : Requis (Bearer token)
- **Body** :
  ```json
  {
    "title": "Vitamine D",  // requis
    "notes": "Prendre avec un repas",  // optionnel
    "status": "active",  // optionnel, défaut: "active"
    "start_date": "2025-01-01T00:00:00Z",  // optionnel
    "end_date": "2025-12-31T00:00:00Z",  // optionnel
    "schedule": {  // optionnel
      "mode": "daily",
      "times": ["08:00"]
    },
    "profile_id": "uuid"  // optionnel
  }
  ```
- **Sécurité** : `owner_user_id` est automatiquement défini à `user.id` (jamais accepté depuis le client)

**Réponse 201** :
```json
{
  "ok": true,
  "supplement": { ... }
}
```

**Erreurs** :
- `400 BAD_REQUEST` : Champs invalides (title manquant, schedule invalide, etc.)
- `401 UNAUTHORIZED` : Token manquant ou invalide
- `500 DATABASE_ERROR` : Erreur de base de données

### PATCH /supplements/:id

Modifie un complément existant.

- **Auth** : Requis (Bearer token)
- **Params** : `id` (UUID du complément)
- **Body** (tous les champs sont optionnels) :
  ```json
  {
    "title": "Vitamine D3",
    "notes": "Nouvelles notes",
    "status": "inactive",
    "start_date": "2025-02-01T00:00:00Z",
    "end_date": null,
    "schedule": {
      "mode": "weekly",
      "times": ["08:00"],
      "daysOfWeek": [1, 3, 5]
    }
  }
  ```
- **Sécurité** : Vérifie que `owner_user_id = user.id` avant modification

**Réponse 200** :
```json
{
  "ok": true,
  "supplement": { ... }
}
```

**Erreurs** :
- `400 BAD_REQUEST` : Champs invalides
- `401 UNAUTHORIZED` : Token manquant ou invalide
- `404 NOT_FOUND` : Complément non trouvé ou n'appartient pas à l'utilisateur
- `500 DATABASE_ERROR` : Erreur de base de données

### DELETE /supplements/:id

Supprime un complément.

- **Auth** : Requis (Bearer token)
- **Params** : `id` (UUID du complément)
- **Sécurité** : Vérifie que `owner_user_id = user.id` avant suppression

**Réponse 200** :
```json
{
  "ok": true
}
```

**Erreurs** :
- `400 BAD_REQUEST` : ID invalide
- `401 UNAUTHORIZED` : Token manquant ou invalide
- `404 NOT_FOUND` : Complément non trouvé ou n'appartient pas à l'utilisateur
- `500 DATABASE_ERROR` : Erreur de base de données

## Sécurité

- **Authentification** : Tous les endpoints requièrent un token JWT Supabase valide
- **Isolation des données** : Toutes les requêtes filtrent automatiquement par `owner_user_id = user.id`
- **Validation** : Le champ `schedule` est validé côté serveur (mode, times, daysOfWeek, dayOfMonth)
- **Service Role** : Le backend utilise `supabaseAdmin` (service_role) qui bypass RLS, d'où la vérification manuelle de `owner_user_id`

## Exemples de requêtes

### Créer un complément quotidien
```bash
curl -X POST https://api.example.com/supplements \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Vitamine D",
    "schedule": {
      "mode": "daily",
      "times": ["08:00"]
    }
  }'
```

### Créer un complément hebdomadaire
```bash
curl -X POST https://api.example.com/supplements \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Fer",
    "schedule": {
      "mode": "weekly",
      "times": ["20:00"],
      "daysOfWeek": [1, 3, 5]
    }
  }'
```

### Modifier le statut
```bash
curl -X PATCH https://api.example.com/supplements/<id> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "inactive"
  }'
```
