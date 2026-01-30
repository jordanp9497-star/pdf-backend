# Configuration de l'authentification Supabase

## Variables d'environnement requises (Railway)

Dans votre projet Railway, ajoutez ces variables dans **Settings > Variables** :

```bash
SUPABASE_URL=https://paspjmhyndqnatsmcjtu.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Où trouver SUPABASE_ANON_KEY ?

1. Allez sur votre projet Supabase : https://supabase.com/dashboard
2. Sélectionnez votre projet
3. Allez dans **Settings > API**
4. Copiez la clé **anon/public** (pas la service_role_key)

### Format de SUPABASE_URL

⚠️ **IMPORTANT** : Le `SUPABASE_URL` doit être la base URL de votre projet, **sans** `/auth/v1` :
- ✅ Correct : `https://paspjmhyndqnatsmcjtu.supabase.co`
- ❌ Incorrect : `https://paspjmhyndqnatsmcjtu.supabase.co/auth/v1`

Le middleware nettoie automatiquement l'URL si nécessaire, mais il est préférable de la configurer correctement.

## Test rapide avec curl

```bash
# 1. Obtenir un token JWT depuis votre app Expo/Supabase
# Le token est généralement obtenu via:
#   const { data: { session } } = await supabase.auth.getSession();
#   const token = session?.access_token;

# 2. Tester l'endpoint avec le token
curl -X POST https://your-backend.railway.app/ordonnances/123e4567-e89b-12d3-a456-426614174000/recovered \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{
    "recoveredAt": "2024-01-15T10:30:00.000Z"
  }'

# Réponse attendue (succès):
# {
#   "ok": true,
#   "ordonnanceId": "123e4567-e89b-12d3-a456-426614174000",
#   "recoveredAt": "2024-01-15T10:30:00.000Z"
# }

# Réponse attendue (erreur 401):
# {
#   "ok": false,
#   "error": "UNAUTHORIZED",
#   "message": "Authentification requise"
# }
```

## Logs DEBUG

Le middleware affiche les logs suivants :

- Au démarrage du serveur :
  ```
  [AUTH] ✅ Client Supabase initialisé pour l'authentification
  [AUTH] SUPABASE_URL: https://paspjmhyndqnatsmcjtu.supabase.co
  ```

- Lors d'une requête avec token valide :
  ```
  [AUTH] Token received len=234
  [AUTH] OK userId=12345678-90ab-cdef-1234-567890abcdef
  ```

- Lors d'une requête sans token :
  ```
  [AUTH] Missing/invalid Authorization header
  ```

- Lors d'un token invalide :
  ```
  [AUTH] Token received len=234
  [AUTH] getUser failed: Invalid token
  ```

## Vérification

1. ✅ Vérifiez que `SUPABASE_URL` et `SUPABASE_ANON_KEY` sont configurées dans Railway
2. ✅ Redémarrez le service Railway après ajout des variables
3. ✅ Vérifiez les logs au démarrage pour confirmer l'initialisation du client Supabase
4. ✅ Testez avec un token JWT valide depuis votre app Supabase
