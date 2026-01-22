# Middlewares d'authentification

Ce dossier contient les middlewares d'authentification Supabase.

## Configuration requise

Ajoutez ces variables d'environnement dans votre `.env` :

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key  # Optionnel, utilise ANON_KEY si absent
```

## Middlewares disponibles

### `authenticateSupabase`

Vérifie le token JWT Supabase dans le header `Authorization: Bearer <token>` et définit `req.user = { id }`.

**Usage :**

```javascript
import { authenticateSupabase } from './middlewares/auth.js';

// Appliquer à toutes les routes d'un router
router.use(authenticateSupabase);

// Ou sur une route spécifique
router.post('/protected', authenticateSupabase, handler);
```

**Réponses d'erreur :**
- `401 UNAUTHORIZED` : Token manquant ou invalide

### `requireProfileRole(profileIdParamName, rolesAllowed)`

Vérifie que l'utilisateur authentifié est membre du profil avec un rôle autorisé.

**Paramètres :**
- `profileIdParamName` : Nom du paramètre contenant le `profile_id` (cherché dans `req.params` puis `req.body`)
- `rolesAllowed` : Tableau des rôles autorisés (ex: `['owner', 'admin', 'member']`)

**Usage :**

```javascript
import { authenticateSupabase } from './middlewares/auth.js';
import { requireProfileRole } from './middlewares/profileRole.js';

// Route avec profile_id dans les params
router.post('/profiles/:profileId/action',
  authenticateSupabase,
  requireProfileRole('profileId', ['owner', 'admin']),
  handler
);

// Route avec profile_id dans le body
router.post('/action',
  authenticateSupabase,
  requireProfileRole('profile_id', ['owner']),
  handler
);
```

**Réponses d'erreur :**
- `401 UNAUTHORIZED` : Utilisateur non authentifié
- `400 BAD_REQUEST` : Paramètre `profileIdParamName` manquant
- `403 FORBIDDEN` : Utilisateur non membre ou rôle insuffisant

**Données ajoutées à `req` :**
- `req.user` : `{ id: string }` (défini par `authenticateSupabase`)
- `req.profileMembership` : `{ profileId, userId, role }` (défini par `requireProfileRole`)

## Exemple complet

```javascript
import express from 'express';
import { authenticateSupabase } from './middlewares/auth.js';
import { requireProfileRole } from './middlewares/profileRole.js';

const router = express.Router();

// Route publique
router.get('/public', (req, res) => {
  res.json({ ok: true, message: 'Public route' });
});

// Route protégée (authentification requise)
router.get('/protected', authenticateSupabase, (req, res) => {
  res.json({ ok: true, userId: req.user.id });
});

// Route avec vérification de profil
router.post('/profiles/:profileId/update',
  authenticateSupabase,
  requireProfileRole('profileId', ['owner', 'admin']),
  (req, res) => {
    // req.user.id : ID de l'utilisateur
    // req.profileMembership.profileId : ID du profil
    // req.profileMembership.role : Rôle de l'utilisateur dans ce profil
    res.json({ 
      ok: true, 
      profileId: req.profileMembership.profileId,
      role: req.profileMembership.role 
    });
  }
);
```
