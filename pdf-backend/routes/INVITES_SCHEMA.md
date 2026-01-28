# Schéma de base de données pour les invitations

Ce document décrit les tables Supabase nécessaires pour le système d'invitations.

## Table `profile_invites` (LEGACY)

Table pour stocker les invitations de profils (ancienne version - usage unique).

### Colonnes

```sql
CREATE TABLE profile_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ
);

-- Index pour recherche rapide par code
CREATE INDEX idx_profile_invites_code ON profile_invites(code) WHERE used_at IS NULL;

-- Index pour recherche par profil
CREATE INDEX idx_profile_invites_profile_id ON profile_invites(profile_id);
```

## Table `profile_invites_v2` (NOUVELLE - codes hashés + multi-usage)

Table pour stocker les invitations avec codes hashés (plus sécurisé).

**Avantages:**
- Le code en clair n'est JAMAIS stocké en base (seulement le hash SHA256 + salt)
- Support multi-usage (max_uses + uses_count)
- Possibilité de révoquer une invitation

### Colonnes

```sql
CREATE TABLE profile_invites_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,  -- SHA256(code + secret), jamais le code en clair
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,  -- Nombre max d'utilisations
  uses_count INTEGER NOT NULL DEFAULT 0,  -- Nombre actuel d'utilisations
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked BOOLEAN NOT NULL DEFAULT FALSE  -- Si true, invitation révoquée
);

-- Index pour recherche rapide par hash
CREATE INDEX idx_profile_invites_v2_code_hash ON profile_invites_v2(code_hash);

-- Index pour recherche par profil
CREATE INDEX idx_profile_invites_v2_profile_id ON profile_invites_v2(profile_id);

-- Index pour invitations actives
CREATE INDEX idx_profile_invites_v2_active ON profile_invites_v2(code_hash) 
  WHERE revoked = FALSE AND uses_count < max_uses;
```

### Variable d'environnement requise

```bash
# Secret pour le hashing des codes (NE PAS CHANGER après création des premières invitations)
INVITE_HASH_SECRET=your-secret-key-here
```

### Fonctionnement

1. **Création (`POST /invites/create`):**
   - Génère un code de 8 caractères (ex: `ABCD1234`)
   - Hash le code: `SHA256(code + INVITE_HASH_SECRET)`
   - Stocke uniquement le hash en base
   - Retourne le code en clair **UNE SEULE FOIS** au client

2. **Utilisation (`POST /invites/redeem`):**
   - Reçoit le code en clair du client
   - Hash le code de la même manière
   - Recherche l'invitation par hash
   - Vérifie: non révoqué, non expiré, uses_count < max_uses
   - Crée l'accès au profil et incrémente uses_count

### Contraintes

- `code` : Unique, non null
- `profile_id` : Référence vers la table `profiles`
- `created_by` : Référence vers `auth.users` (le propriétaire qui crée l'invitation)
- `used_by` : Référence vers `auth.users` (l'utilisateur qui a utilisé l'invitation)
- `used_at` : NULL si non utilisée, timestamp si utilisée

## Table `profile_members`

Table pour stocker les membres des profils (déjà existante, mais vérifiez la structure).

### Colonnes attendues

```sql
CREATE TABLE profile_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'AIDANT')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(profile_id, user_id)
);

-- Index pour recherche rapide
CREATE INDEX idx_profile_members_profile_id ON profile_members(profile_id);
CREATE INDEX idx_profile_members_user_id ON profile_members(user_id);
```

### Rôles

- `owner` : Propriétaire du profil (peut créer des invitations)
- `admin` : Administrateur
- `member` : Membre standard
- `AIDANT` : Rôle assigné lors de l'acceptation d'une invitation

## RLS (Row Level Security)

Assurez-vous que les politiques RLS sont configurées correctement :

```sql
-- Les utilisateurs peuvent voir les invitations de leurs profils
CREATE POLICY "Users can view invites for their profiles"
ON profile_invites FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM profile_members
    WHERE profile_members.profile_id = profile_invites.profile_id
    AND profile_members.user_id = auth.uid()
  )
);

-- Les propriétaires peuvent créer des invitations
CREATE POLICY "Owners can create invites"
ON profile_invites FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM profile_members
    WHERE profile_members.profile_id = profile_invites.profile_id
    AND profile_members.user_id = auth.uid()
    AND profile_members.role = 'owner'
  )
);

-- Les utilisateurs peuvent voir leurs propres membreships
CREATE POLICY "Users can view their memberships"
ON profile_members FOR SELECT
USING (user_id = auth.uid() OR profile_id IN (
  SELECT profile_id FROM profile_members WHERE user_id = auth.uid()
));
```

## Notes

- Les codes d'invitation sont en majuscules et utilisent uniquement des caractères non-ambigus (pas de 0, O, I, l)
- Les invitations expirent après 7 jours
- Un code ne peut être utilisé qu'une seule fois
- Un utilisateur ne peut pas accepter une invitation pour un profil dont il est déjà membre
