# Architecture

**Analysis Date:** 2026-01-15

## Pattern Overview

**Overall:** Multi-component system (Expo mobile client + Express API backend + optional Python microservice)

**Key Characteristics:**
- Mobile app uses Expo Router (file-based routing) and React Context for global state: `Medicalia/medical-assistant/app/_layout.tsx`, `Medicalia/medical-assistant/contexts/*.tsx`
- Backend is an Express server with most routes implemented in a single large file: `pdf-backend/index.js`
- Document processing relies on external AI/OCR services (OpenAI, Mistral, n8n webhooks): `pdf-backend/index.js`
- Persistent storage is primarily client-side (AsyncStorage) + backend in-memory Maps/arrays (no DB detected): `Medicalia/medical-assistant/utils/ordonnanceStorage.ts`, `pdf-backend/index.js`

## Layers

(Mobile + backend are separate codebases; layers listed per subproject.)

**Mobile App (Expo / React Native):**
- Purpose: UX, local persistence, device integrations, and orchestration of document ingestion flows.
- Contains:
  - Route/screens layer: `Medicalia/medical-assistant/app/**`
  - UI components: `Medicalia/medical-assistant/components/**`
  - State providers (contexts): `Medicalia/medical-assistant/contexts/**`
  - Domain models/types: `Medicalia/medical-assistant/models/**`, `Medicalia/medical-assistant/types/**`
  - Services/helpers (API, storage, device features): `Medicalia/medical-assistant/utils/**`, `Medicalia/medical-assistant/services/**`, `Medicalia/medical-assistant/src/services/**`
  - Configuration/constants: `Medicalia/medical-assistant/config/**`, `Medicalia/medical-assistant/constants/**`
- Depends on: backend HTTP APIs + native device APIs via Expo modules.
- Used by: end users on iOS/Android.

**Backend API (Express):**
- Purpose: Provide endpoints for PDF/text extraction, OCR photo processing, AI summarization, QR flows, and (some) delivery/order flows.
- Contains:
  - Express app + middleware + most route handlers: `pdf-backend/index.js`
  - Small extracted router(s): `pdf-backend/routes/aiSummary.routes.js`
  - Optional Python microservice folder (deployed separately): `pdf-backend/opencv-preprocess/**`
- Depends on: external AI/OCR services (OpenAI, Mistral, n8n), and optional OpenCV preprocess service.
- Used by: mobile app via HTTP calls.

**OpenCV Preprocess Service (FastAPI, optional):**
- Purpose: Image preprocessing (deskew/threshold/etc.) before OCR.
- Contains: `pdf-backend/opencv-preprocess/app.py`
- Depends on: OpenCV + numpy.
- Used by: backend when `OPENCV_PREPROCESS_URL` is configured: `pdf-backend/index.js`

## Data Flow

**Mobile App Startup:**
1. Expo loads entry: `expo-router/entry` (`Medicalia/medical-assistant/package.json`).
2. Root layout mounts providers and navigation: `Medicalia/medical-assistant/app/_layout.tsx`.
3. App resolves backend base URL via config (Expo `extra` / env): `Medicalia/medical-assistant/config/api.ts`, `Medicalia/medical-assistant/config/env.ts`, `Medicalia/medical-assistant/app.json`.
4. Optional health check/ping to backend: `Medicalia/medical-assistant/utils/networkTest.ts`.

**Document Ingestion (PDF):**
1. User selects PDF on device.
2. Mobile uploads PDF with `FormData` to backend extraction endpoint:
   - Client: `Medicalia/medical-assistant/utils/documentSummary.ts`
   - URL builder: `Medicalia/medical-assistant/config/api.ts`
3. Backend parses multipart upload (multer memory storage) and extracts text: `pdf-backend/index.js`.
4. Backend returns extracted text/summary response; mobile stores local artifacts (AsyncStorage): `Medicalia/medical-assistant/utils/documentSummary.ts`.

**Document Ingestion (Photo OCR):**
1. Mobile captures/chooses image, converts to base64.
2. Mobile calls OCR endpoint:
   - Client: `Medicalia/medical-assistant/src/lib/ocrClient.ts`
   - URL builder: `Medicalia/medical-assistant/config/api.ts`
3. Backend optionally preprocesses image via OpenCV microservice when configured: `pdf-backend/index.js`, `pdf-backend/opencv-preprocess/app.py`.
4. Backend calls external OCR/structuring pipelines (n8n webhook + optionally OpenAI/Mistral) and returns structured output: `pdf-backend/index.js`.

**AI Medical Summary:**
1. Mobile calls backend summary endpoint:
   - Client: `Medicalia/medical-assistant/src/services/aiMedicalSummary.ts`
2. Backend generates summary using OpenAI and internal/fallback logic:
   - Handler/router: `pdf-backend/index.js`, `pdf-backend/routes/aiSummary.routes.js`
3. Mobile caches/persists the resulting summary:
   - Cache: `Medicalia/medical-assistant/src/services/medicalSummaryCache.ts`

**QR Flows (Ordonnance / Passport):**
1. Mobile requests QR token generation and receives a signed token + deep link/web URL:
   - Client: `Medicalia/medical-assistant/utils/qrOrdonnance.ts`, `Medicalia/medical-assistant/utils/passportQR.ts`
2. Backend signs tokens using env-provided secrets: `pdf-backend/index.js`.

**State Management:**
- Mobile:
  - In-memory: React Context state for auth/ordonnances/draft: `Medicalia/medical-assistant/contexts/*.tsx`
  - Persistent: AsyncStorage for auth flags + domain entities: `Medicalia/medical-assistant/utils/authStorage.ts`, `Medicalia/medical-assistant/utils/ordonnanceStorage.ts`
- Backend:
  - In-memory only (arrays/maps), resets on restart: `pdf-backend/index.js`
- OpenCV service:
  - Stateless HTTP processing (no persistence detected): `pdf-backend/opencv-preprocess/app.py`

## Key Abstractions

**API Base URL Resolution (Mobile):**
- Purpose: Centralize backend base URL selection and safety checks.
- Examples: `Medicalia/medical-assistant/config/api.ts`, `Medicalia/medical-assistant/config/env.ts`
- Pattern: config helper + runtime validation.

**HTTP Client Wrapper (Mobile):**
- Purpose: Standardize fetch requests (timeouts, retries, JSON parsing).
- Examples: `Medicalia/medical-assistant/utils/apiClient.ts`
- Pattern: wrapper functions (`apiFetch`, `apiFetchJson`) + error translation.

**Network Error → User Message Mapping (Mobile):**
- Purpose: Convert technical errors into user-friendly alerts.
- Examples: `Medicalia/medical-assistant/utils/networkErrorHandler.ts`
- Pattern: classifier + alert helper.

**Local Storage “Stores” (Mobile):**
- Purpose: Encapsulate persistence logic around AsyncStorage.
- Examples: `Medicalia/medical-assistant/utils/ordonnanceStorage.ts`, `Medicalia/medical-assistant/services/healthProfileStore.ts`
- Pattern: module-level `get/save/clear` functions.

**Express Route Handlers (Backend):**
- Purpose: API endpoints for document ingestion and AI summarization.
- Examples: `pdf-backend/index.js`, `pdf-backend/routes/aiSummary.routes.js`
- Pattern: route-per-feature in `index.js` + a small router for `/ai/*`.

## Entry Points

**Mobile App:**
- Location: `Medicalia/medical-assistant/package.json` (`main: "expo-router/entry"`)
- Root layout and providers: `Medicalia/medical-assistant/app/_layout.tsx`

**Backend API:**
- Location: `pdf-backend/index.js`
- Triggers: `npm run start` / `npm run dev`: `pdf-backend/package.json`

**OpenCV Preprocess Service:**
- Location: `pdf-backend/opencv-preprocess/app.py`
- Trigger: `uvicorn app:app --host 0.0.0.0 --port 8000`: `pdf-backend/opencv-preprocess/Dockerfile`

## Error Handling

**Strategy:**
- Mobile: throw Errors from low-level helpers; UI layer shows alerts via a centralized error mapper.
- Backend: per-route `try/catch` and JSON `{ ok: false, error: ... }` patterns; no global error middleware detected.

**Patterns:**
- Mobile timeout/retry logic in HTTP wrapper: `Medicalia/medical-assistant/utils/apiClient.ts`
- Mobile user-friendly messaging: `Medicalia/medical-assistant/utils/networkErrorHandler.ts`
- Backend route-level error responses: `pdf-backend/index.js`, `pdf-backend/routes/aiSummary.routes.js`

## Cross-Cutting Concerns

**Logging:**
- Mobile logger helpers: `Medicalia/medical-assistant/utils/logger.ts` (plus some direct `console.log` usage)
- Backend uses console logging + request logging middleware: `pdf-backend/index.js`

**Validation:**
- Mobile: ad-hoc checks in screens/services (no shared schema library detected)
- Backend: manual body validation helpers embedded in `pdf-backend/index.js`

**Authentication:**
- Mobile: client-side “isAuthenticated” gating via context; no token-based backend enforcement detected: `Medicalia/medical-assistant/contexts/AuthContext.tsx`, `Medicalia/medical-assistant/hooks/use-protected-route.ts`
- Backend: no auth middleware detected across routes; CORS is enabled globally: `pdf-backend/index.js`

---

*Architecture analysis: 2026-01-15*
*Update when major patterns change*
