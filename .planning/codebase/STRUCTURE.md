# Codebase Structure

**Analysis Date:** 2026-01-15

## Directory Layout

```text
app/
├── Medicalia/                     # Mobile app workspace
│   └── medical-assistant/         # Expo / React Native app (has its own .git)
├── pdf-backend/                   # Node/Express backend (PDF/OCR/AI/QR)
├── OrdonnanceA.png                # Sample assets
├── ordonnanceB.png                # Sample assets
├── build.json.txt                 # Workflow/config artifact
├── medicalia_workflow.json        # Workflow/config artifact
└── .planning/                     # Planning outputs (generated)
    └── codebase/                  # This codebase map
```

## Directory Purposes

**Medicalia/medical-assistant/**
- Purpose: Expo mobile application (Medicalia “medical assistant”).
- Contains: File-based routes, UI components, storage/utils, device integrations.
- Key files:
  - App config: `Medicalia/medical-assistant/app.json`
  - EAS builds: `Medicalia/medical-assistant/eas.json`
  - Entry point: `Medicalia/medical-assistant/package.json` (`main: "expo-router/entry"`)
  - Root layout/providers: `Medicalia/medical-assistant/app/_layout.tsx`
- Subdirectories (high signal):
  - `Medicalia/medical-assistant/app/` - Expo Router routes/screens
  - `Medicalia/medical-assistant/components/` - Reusable UI components
  - `Medicalia/medical-assistant/contexts/` - Global state providers
  - `Medicalia/medical-assistant/hooks/` - Reusable hooks
  - `Medicalia/medical-assistant/utils/` - API client, storage, mapping, helpers
  - `Medicalia/medical-assistant/services/` - “store” modules and device-side services
  - `Medicalia/medical-assistant/src/` - Additional service/lib layer (AI summary + cache)
  - `Medicalia/medical-assistant/models/` and `Medicalia/medical-assistant/types/` - Domain types

**pdf-backend/**
- Purpose: Backend API for document ingestion (PDF/OCR), AI summarization, QR flows, and related features.
- Contains: Express server, route handlers, optional preprocessing service.
- Key files:
  - Server entry: `pdf-backend/index.js`
  - Router module: `pdf-backend/routes/aiSummary.routes.js`
  - Backend config: `pdf-backend/package.json` (ESM via `type: module`)
- Subdirectories:
  - `pdf-backend/routes/` - Express routers
  - `pdf-backend/opencv-preprocess/` - Python FastAPI microservice (Dockerized)

**pdf-backend/opencv-preprocess/**
- Purpose: Image preprocessing endpoint (deskew/threshold/etc.).
- Key files:
  - FastAPI app: `pdf-backend/opencv-preprocess/app.py`
  - Docker build/runtime: `pdf-backend/opencv-preprocess/Dockerfile`
  - Python deps: `pdf-backend/opencv-preprocess/requirements.txt`

## Key File Locations

**Entry Points:**
- `Medicalia/medical-assistant/package.json` - Mobile app entry (`expo-router/entry`)
- `Medicalia/medical-assistant/app/_layout.tsx` - Provider wiring + root navigation
- `pdf-backend/index.js` - Express server startup + most route handlers
- `pdf-backend/opencv-preprocess/app.py` - FastAPI preprocess service

**Configuration:**
- `Medicalia/medical-assistant/app.json` - Expo app config + `expo.extra` runtime config
- `Medicalia/medical-assistant/eas.json` - EAS build profiles + env injection
- `Medicalia/medical-assistant/tsconfig.json` - TS strict mode + `@/*` alias
- `Medicalia/medical-assistant/eslint.config.js` - ESLint (Expo)
- `pdf-backend/package.json` - Backend deps + scripts

**Core Logic:**
- Mobile API configuration: `Medicalia/medical-assistant/config/api.ts`, `Medicalia/medical-assistant/config/env.ts`
- Mobile HTTP client: `Medicalia/medical-assistant/utils/apiClient.ts`
- Mobile persistence: `Medicalia/medical-assistant/utils/ordonnanceStorage.ts`, `Medicalia/medical-assistant/utils/documentSummary.ts`
- Mobile AI services: `Medicalia/medical-assistant/src/services/aiMedicalSummary.ts`, `Medicalia/medical-assistant/src/services/medicalSummaryCache.ts`
- Backend route handlers: `pdf-backend/index.js`, `pdf-backend/routes/aiSummary.routes.js`

**Testing:**
- No automated test suite detected
- Example/manual test modules exist:
  - `Medicalia/medical-assistant/src/services/medicalSummaryCache.test.example.ts`

**Documentation:**
- Mobile build/release docs:
  - `Medicalia/medical-assistant/BUILD_VERIFICATION.md`
  - `Medicalia/medical-assistant/TESTFLIGHT_CHECKLIST.md`
  - `Medicalia/medical-assistant/SUBMIT_TESTFLIGHT_GUIDE.md`

## Naming Conventions

**Files (Mobile app):**
- Route files follow Expo Router conventions (groups like `(tabs)` and dynamic segments like `[id]`): `Medicalia/medical-assistant/app/**`
- Components: `PascalCase.tsx`: `Medicalia/medical-assistant/components/PrescriptionEditor.tsx`
- Hooks: `kebab-case.ts`: `Medicalia/medical-assistant/hooks/use-protected-route.ts`
- Utilities/services: typically `camelCase.ts`: `Medicalia/medical-assistant/utils/apiClient.ts`, `Medicalia/medical-assistant/services/healthProfileStore.ts`

**Directories:**
- Lowercase (mostly), sometimes route-group syntax for Expo Router: `Medicalia/medical-assistant/app/(tabs)/`

## Where to Add New Code

**New Feature (Mobile):**
- UI route/screen: `Medicalia/medical-assistant/app/` (choose appropriate route group)
- Domain logic/helpers: `Medicalia/medical-assistant/utils/`
- Global state: `Medicalia/medical-assistant/contexts/` and wire into `Medicalia/medical-assistant/app/_layout.tsx`
- Device integration/service: `Medicalia/medical-assistant/services/`

**New Backend Route:**
- If it’s AI/summary related: add to `pdf-backend/routes/aiSummary.routes.js` and mount in `pdf-backend/index.js`
- Otherwise, current pattern is to add directly to `pdf-backend/index.js` near related endpoints

**New Image/PDF Processing Step:**
- Backend orchestration: `pdf-backend/index.js`
- OpenCV preprocess: `pdf-backend/opencv-preprocess/app.py` (if the step belongs to preprocessing)

## Special Directories

**Medicalia/medical-assistant/.git/**
- Purpose: Indicates the mobile app may be a standalone git repo nested in this workspace.
- Careful: git operations at the top-level repo won’t automatically include nested repo changes.

---

*Structure analysis: 2026-01-15*
*Update when directory structure changes*
