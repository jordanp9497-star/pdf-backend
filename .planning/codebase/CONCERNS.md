# Codebase Concerns

**Analysis Date:** 2026-01-15

## Tech Debt

**Backend “god file”:**
- Issue: Majority of backend logic lives in one large file (routes + logic + integrations + storage).
- Files: `pdf-backend/index.js`
- Why: Rapid iteration; easiest place to add endpoints.
- Impact: Hard to reason about correctness/security; refactors and reviews are risky.
- Fix approach: Extract feature routers under `pdf-backend/routes/` and move integration helpers to dedicated modules.

**Incomplete/placeholder product wiring:**
- Issue: TODOs in user-facing settings and flows (privacy policy, data deletion, etc.).
- Files: `Medicalia/medical-assistant/app/(tabs)/parametres.tsx`
- Impact: UX and compliance gaps.

## Known Bugs

**Medical summary cache hash may ignore nested fields:**
- Symptoms: Potential stale cache hits if nested personal/ordonnance fields change.
- Trigger: Hash generation uses `JSON.stringify(obj, Object.keys(obj).sort())` which can behave as a whitelist across nesting.
- File: `Medicalia/medical-assistant/src/services/medicalSummaryCache.ts`

**Duplicate health endpoint definitions (backend):**
- Symptoms: Confusing monitoring/client behavior if `/healthz` responds differently depending on handler order.
- File: `pdf-backend/index.js`

## Security Considerations

**Checked-in `.env` files / secrets exposure risk:**
- Risk: Secrets may be committed or leaked through backups/sharing.
- Files: `Medicalia/medical-assistant/.env`, `pdf-backend/.env`
- Recommendations: Ensure `.env` is gitignored and not committed; rotate any secrets that may have been exposed; add `.env.example` instead.

**Backend logs secret material:**
- Risk: Prints the raw OpenAI key; leaks credentials into logs.
- File: `pdf-backend/index.js`
- Recommendations: Remove logging of secret values; log boolean presence only.

**Backend has wide-open CORS + no obvious auth boundary:**
- Risk: Any origin can call endpoints; sensitive medical data routes appear unauthenticated.
- File: `pdf-backend/index.js`
- Recommendations: Restrict CORS origins; add authentication/authorization middleware; consider request signing for mobile.

**Debug endpoints and default secrets:**
- Risk: Debug endpoints can leak payloads; default secret fallback is dangerous in misconfigured deployments.
- Files: `pdf-backend/index.js`
- Recommendations: Disable debug endpoints in production; require secrets to be set (no fallbacks).

**Sensitive data stored/logged on-device:**
- Risk: AsyncStorage is not encrypted by default; console logging may leak tokens/PII to device logs.
- Files:
  - `Medicalia/medical-assistant/utils/documentSummary.ts`
  - `Medicalia/medical-assistant/utils/ordonnanceStorage.ts`
  - `Medicalia/medical-assistant/utils/apiClient.ts`
  - `Medicalia/medical-assistant/utils/passportQR.ts`
- Recommendations: Store sensitive fields in encrypted storage (`expo-secure-store` or encrypted DB) and gate logs behind `__DEV__`.

**OpenCV microservice has no auth/rate limiting:**
- Risk: If exposed publicly, can be abused for DoS (large base64 payloads).
- Files: `pdf-backend/opencv-preprocess/app.py`
- Recommendations: Add auth (shared secret), max payload size checks, and rate limiting.

## Performance Bottlenecks

**Large payload + in-memory uploads:**
- Problem: Backend accepts large bodies (25mb JSON limit) and uses multer memory storage; can exhaust RAM.
- File: `pdf-backend/index.js`
- Improvement path: Stream uploads to disk/object storage; reduce limits; add queueing/concurrency controls.

**CPU-heavy OCR/AI work without backpressure:**
- Problem: OCR + LLM calls are expensive; without rate limits/queues, a few concurrent requests can overload.
- File: `pdf-backend/index.js`
- Improvement path: Add a job queue, timeouts, and per-route rate limiting.

**Aggressive client polling loops:**
- Problem: Infinite polling loop can drain battery/network and hammer backend if used broadly.
- File: `Medicalia/medical-assistant/utils/jobPoller.ts`

## Fragile Areas

**Backend URL fallback behavior:**
- Why fragile: Hardcoded fallback backend URL can accidentally point misconfigured builds at the wrong environment.
- Files: `Medicalia/medical-assistant/config/api.ts`, `Medicalia/medical-assistant/app.json`

**Backend route complexity and mixed flows:**
- Why fragile: Multiple OCR/document routes with special cases and heavy logging; easy to break.
- File: `pdf-backend/index.js`

## Scaling Limits

**In-memory backend storage:**
- Limit: Data resets on restart and cannot scale across multiple instances.
- Files: `pdf-backend/index.js`
- Scaling path: Move state to a real database (and make endpoints idempotent).

**No queueing/backpressure for OCR/AI:**
- Limit: Throughput constrained by single instance CPU/memory.
- Files: `pdf-backend/index.js`
- Scaling path: Background jobs + worker pool + status polling.

## Dependencies at Risk

**Legacy upload middleware version:**
- Risk: `multer` is on 1.x LTS; keep an eye on known issues and upgrade path.
- File: `pdf-backend/package.json`

**Potentially unused security/auth dependencies:**
- Risk: Unused deps increase maintenance and attack surface.
- Files: `pdf-backend/package.json` (`jsonwebtoken`, `jwks-rsa`)

**Backend depends on Expo (unusual):**
- Risk: Inflated dependency graph for a server; may complicate deployments.
- File: `pdf-backend/package.json`

## Missing Critical Features

**Automated tests:**
- Problem: No automated test runner configured for either project.
- Files: `Medicalia/medical-assistant/package.json`, `pdf-backend/package.json`

**Backend auth + data retention strategy:**
- Problem: Sensitive medical endpoints appear unauthenticated and state is in-memory.
- File: `pdf-backend/index.js`

## Test Coverage Gaps

**Critical flows not covered by tests:**
- AI summarization endpoints: `pdf-backend/index.js`, `pdf-backend/routes/aiSummary.routes.js`
- OCR/photo and PDF processing endpoints: `pdf-backend/index.js`
- Local persistence and deduplication logic: `Medicalia/medical-assistant/utils/ordonnanceStorage.ts`

---

*Concerns audit: 2026-01-15*
*Update as issues are fixed or new ones discovered*
