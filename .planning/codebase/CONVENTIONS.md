# Coding Conventions

**Analysis Date:** 2026-01-15

## Naming Patterns

**Files:**
- Expo Router routes follow file-based routing conventions:
  - Route groups in parentheses: `Medicalia/medical-assistant/app/(tabs)/_layout.tsx`
  - Dynamic segments in brackets: `Medicalia/medical-assistant/app/ordonnances/detail-rdv/[id].tsx`
- Components are typically `PascalCase.tsx`: `Medicalia/medical-assistant/components/PrescriptionEditor.tsx`
- Hooks are typically `kebab-case.ts`: `Medicalia/medical-assistant/hooks/use-protected-route.ts`
- Utilities/services are typically `camelCase.ts`: `Medicalia/medical-assistant/utils/apiClient.ts`, `Medicalia/medical-assistant/services/healthProfileStore.ts`
- Backend routes use `camelCase`/mixed naming under `routes/`: `pdf-backend/routes/aiSummary.routes.js`

**Functions:**
- `camelCase` for functions and handlers (e.g., `getApiBaseUrl`, `pingServer`): `Medicalia/medical-assistant/config/api.ts`, `Medicalia/medical-assistant/utils/networkTest.ts`

**Variables:**
- `camelCase` for locals and state.
- Constants often use `UPPER_SNAKE_CASE` for env/constants (backend): `pdf-backend/index.js`

**Types:**
- `PascalCase` for TS types and models: `Medicalia/medical-assistant/models/Ordonnance.ts`, `Medicalia/medical-assistant/types/medication.ts`

## Code Style

**Formatting:**
- 2-space indentation is common (mobile + backend): `Medicalia/medical-assistant/app/_layout.tsx`, `pdf-backend/routes/aiSummary.routes.js`
- Single quotes for strings: `Medicalia/medical-assistant/app/_layout.tsx`, `pdf-backend/routes/aiSummary.routes.js`
- Semicolons are used consistently: `Medicalia/medical-assistant/app/_layout.tsx`, `pdf-backend/routes/aiSummary.routes.js`

**Linting:**
- Mobile app: ESLint via Expo flat config: `Medicalia/medical-assistant/eslint.config.js`
  - Run: `npm run lint` (`expo lint`): `Medicalia/medical-assistant/package.json`
- Backend: No ESLint/Prettier config detected.

## Import Organization

**Order:**
1. External packages first
2. Blank line
3. Internal imports (mobile uses `@/*` alias)

Example (mobile root layout): `Medicalia/medical-assistant/app/_layout.tsx`

**Path Aliases:**
- Mobile uses `@/*` alias to project root: `Medicalia/medical-assistant/tsconfig.json`

## Error Handling

**Patterns (Mobile):**
- Centralized fetch wrapper throws errors with friendly messages (timeouts/retries): `Medicalia/medical-assistant/utils/apiClient.ts`
- User-friendly alert mapping helper for network/config errors: `Medicalia/medical-assistant/utils/networkErrorHandler.ts`
- Domain-specific error classes exist in some utilities (e.g., duplicate ordonnance): `Medicalia/medical-assistant/utils/ordonnanceStorage.ts`

**Patterns (Backend):**
- Express handlers use guard clauses + early `return res.status(...).json(...)`: `pdf-backend/routes/aiSummary.routes.js`
- Larger handlers use `try/catch` and return structured JSON errors: `pdf-backend/index.js`

## Logging

**Framework:**
- Predominantly `console.log` / `console.error` across both subprojects.
- Mobile also has lightweight helpers:
  - `devLog` (dev-only) and `logError` (always): `Medicalia/medical-assistant/utils/logger.ts`

**Patterns:**
- Backend request-level logging middleware exists in `pdf-backend/index.js`.
- Some logs may include sensitive payload fragments (see `CONCERNS.md`).

## Comments

**When to Comment (observed):**
- JSDoc-style blocks are used to explain components/flows (French language): `Medicalia/medical-assistant/app/_layout.tsx`, `pdf-backend/routes/aiSummary.routes.js`

**TODO Comments:**
- Present in app screens and backend; track as concerns when they affect correctness: `Medicalia/medical-assistant/app/(tabs)/parametres.tsx`, `pdf-backend/index.js`

## Function Design

**Size:**
- Mobile UI components are typically mid-sized, readable, and rely on helper modules.
- Backend `pdf-backend/index.js` contains very large functions/sections; consider extracting routers/services when making significant changes.

## Module Design

**Exports:**
- Mobile code uses named exports heavily for utilities and contexts: `Medicalia/medical-assistant/contexts/AuthContext.tsx`, `Medicalia/medical-assistant/utils/apiClient.ts`
- Backend route modules default-export an Express router: `pdf-backend/routes/aiSummary.routes.js`

---

*Convention analysis: 2026-01-15*
*Update when patterns change*
