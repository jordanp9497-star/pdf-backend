# Schéma de base de données pour les invitations

Ce document décrit les tables Supabase nécessaires pour le système d'invitations.

## Table `profile_invites`

Table pour stocker les invitations de profils.

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
