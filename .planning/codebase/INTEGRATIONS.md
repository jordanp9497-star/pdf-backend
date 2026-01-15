# External Integrations

**Analysis Date:** 2026-01-15

## APIs & External Services

**Payment Processing:**
- Not detected

**Email/SMS:**
- Not detected

**AI / OCR / Document Processing:**
- OpenAI API - LLM summarization and pre-structuring
  - SDK/Client: `openai` npm package: `pdf-backend/package.json`
  - Auth: `OPENAI_API_KEY` (env var name only): `pdf-backend/index.js`
  - Usage: summary endpoints and OCR/ordonnance flows: `pdf-backend/index.js`, `pdf-backend/routes/aiSummary.routes.js`
- Mistral API - OCR / handwritten extraction (via HTTP)
  - Auth: `MISTRAL_API_KEY` (env var name only): `pdf-backend/index.js`
  - Usage: OCR handwritten route: `pdf-backend/index.js`
- n8n Cloud webhooks - PDF ordonnance structuring + OCR image processing
  - Integration method: outbound `fetch(...)` calls to webhook URLs
  - URLs currently hardcoded (not env-configured): `pdf-backend/index.js`

**External URLs (deep links / browser opens):**
- Doctolib - opens external appointment booking URLs from the app: `Medicalia/medical-assistant/app/(tabs)/ordonnances.tsx`, `Medicalia/medical-assistant/app/ordonnances/detail-rdv/[id].tsx`
- Google Maps directions - opens external maps URL: `Medicalia/medical-assistant/app/(tabs)/pharmacies.tsx`

## Data Storage

**Databases:**
- Not detected (backend appears to be in-memory only)
  - In-memory ordonnances storage: `pdf-backend/index.js`
  - In-memory delivery orders / passport summaries: `pdf-backend/index.js`

**File Storage:**
- Mobile app local storage (non-encrypted by default):
  - Ordonnances/documents in AsyncStorage: `Medicalia/medical-assistant/utils/ordonnanceStorage.ts`, `Medicalia/medical-assistant/utils/documentSummary.ts`
- Backend file uploads:
  - Multer memory storage (uploads held in RAM): `pdf-backend/index.js`

**Caching:**
- Mobile-side medical summary cache (local): `Medicalia/medical-assistant/src/services/medicalSummaryCache.ts`

## Authentication & Identity

**Auth Provider (Mobile):**
- Apple Sign-In (Expo plugin): `Medicalia/medical-assistant/package.json`, `Medicalia/medical-assistant/app.json`
- Google Sign-In (native module + wrapper):
  - Module/plugin config: `Medicalia/medical-assistant/app.json`
  - Wrapper/util: `Medicalia/medical-assistant/utils/googleSignInWrapper.ts`

**Backend Auth:**
- No global auth middleware detected for API routes.
- JWT-related deps exist but usage wasn’t clearly found:
  - `jsonwebtoken`, `jwks-rsa`: `pdf-backend/package.json`

## Monitoring & Observability

**Error Tracking:**
- Not detected

**Analytics:**
- Not detected

**Logs:**
- Mobile: console logging + lightweight helpers: `Medicalia/medical-assistant/utils/logger.ts`
- Backend: console logging + request logging middleware: `pdf-backend/index.js`

## CI/CD & Deployment

**Hosting:**
- Backend hosting inferred as Railway (mobile config points at a Railway URL): `Medicalia/medical-assistant/app.json`
- Mobile builds via EAS profiles (dev/preview/prod): `Medicalia/medical-assistant/eas.json`

**CI Pipeline:**
- Not detected (no `.github/workflows/` found)

## Environment Configuration

**Development (Mobile):**
- Primary runtime config comes from Expo config:
  - `API_BASE_URL` via `expo.extra`: `Medicalia/medical-assistant/app.json`, `Medicalia/medical-assistant/config/env.ts`
- Also present: Expo public env vars (dev/EAS):
  - `EXPO_PUBLIC_API_URL` (local `.env` file exists)
  - `EXPO_PUBLIC_API_BASE_URL` (injected by EAS): `Medicalia/medical-assistant/eas.json`

**Development (Backend):**
- dotenv loads `.env`: `pdf-backend/index.js`
- Env var names referenced:
  - `NODE_ENV`, `PORT`
  - `OPENAI_API_KEY`
  - `MISTRAL_API_KEY`
  - `OPENCV_PREPROCESS_URL`
  - `TEST_RDV_EXTRACTION`
  - `QR_SECRET`, `PASSPORT_QR_SECRET`
  - `PUBLIC_WEB_BASE_URL`

**Production:**
- Secrets management not documented (likely platform env vars); avoid committing `.env` files.

## Webhooks & Callbacks

**Incoming:**
- Not detected

**Outgoing:**
- n8n webhook calls (PDF structuring + OCR image): `pdf-backend/index.js`

---

*Integration audit: 2026-01-15*
*Update when adding/removing external services*
