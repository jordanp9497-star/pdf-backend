# Schéma de la table `care_links`

## Table SQL

```sql
CREATE TABLE care_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  caregiver_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
  role TEXT DEFAULT 'AIDANT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Contrainte: un patient ne peut avoir qu'un seul lien actif avec un aidant
  UNIQUE(patient_user_id, caregiver_user_id, status) WHERE status = 'active'
);

-- Index pour les requêtes fréquentes
CREATE INDEX idx_care_links_patient ON care_links(patient_user_id);
CREATE INDEX idx_care_links_caregiver ON care_links(caregiver_user_id);
CREATE INDEX idx_care_links_status ON care_links(status);
```

## RLS (Row Level Security)

```sql
-- Désactiver RLS pour cette table (le backend utilise service_role qui bypass RLS)
ALTER TABLE care_links DISABLE ROW LEVEL SECURITY;

-- OU activer RLS avec des politiques si nécessaire:
-- ALTER TABLE care_links ENABLE ROW LEVEL SECURITY;

-- Politique: les patients peuvent voir leurs liens
-- CREATE POLICY "Patients can view their links"
--   ON care_links FOR SELECT
--   USING (auth.uid() = patient_user_id);

-- Politique: les aidants peuvent voir les liens où ils sont aidants
-- CREATE POLICY "Caregivers can view their links"
--   ON care_links FOR SELECT
--   USING (auth.uid() = caregiver_user_id);
```

## États du lien

- `pending`: Invitation envoyée, en attente d'acceptation
- `active`: Lien actif, l'aidant peut accéder aux données du patient
- `revoked`: Lien révoqué par le patient

## Endpoints

### POST /care/invite
- **Auth**: Requis (patient)
- **Body**: `{ caregiverEmail: string, role?: string }`
- **Retour**: `{ ok: true, linkId: string }`

### POST /care/accept
- **Auth**: Requis (aidant)
- **Body**: `{ linkId: string }`
- **Retour**: `{ ok: true }`

### POST /care/revoke
- **Auth**: Requis (patient)
- **Body**: `{ linkId: string }`
- **Retour**: `{ ok: true }`
