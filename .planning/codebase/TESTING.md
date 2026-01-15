# Testing Patterns

**Analysis Date:** 2026-01-15

## Test Framework

**Runner:**
- Not detected (no Jest/Vitest/Detox/Playwright configuration found)
- No `test` script present in either `Medicalia/medical-assistant/package.json` or `pdf-backend/package.json`

**Assertion Library:**
- Not applicable (no automated test runner configured)

**Run Commands:**
```bash
# Mobile app (manual/dev verification)
cd Medicalia/medical-assistant
npm run lint            # Lint (expo lint)
npm run start           # Start Expo dev server

# Backend (manual/dev verification)
cd pdf-backend
npm run start           # Start Express server

# OpenCV preprocess service (optional)
# build/run via Dockerfile
```

## Test File Organization

**Location:**
- Not detected (no `tests/` directory and no conventional `*.test.*` / `*.spec.*` patterns found)

**Naming:**
- Not detected

**Structure:**
- Manual/example test modules exist (not wired into a test runner):
  - `Medicalia/medical-assistant/src/services/medicalSummaryCache.test.example.ts`

## Test Structure

**Suite Organization:**
- Not applicable

**Patterns:**
- Not applicable

## Mocking

**Framework:**
- Not applicable

**Patterns:**
- Not applicable

**What to Mock / What NOT to Mock:**
- Not applicable (until a test framework is introduced)

## Fixtures and Factories

**Test Data:**
- Not detected

**Location:**
- Not detected

## Coverage

**Requirements:**
- Not detected

**Configuration:**
- Not detected

**View Coverage:**
- Not detected

## Test Types

**Unit Tests:**
- Not detected

**Integration Tests:**
- Not detected

**E2E Tests:**
- Not detected

## Common Patterns

**Async Testing / Error Testing / Snapshot Testing:**
- Not applicable

---

*Testing analysis: 2026-01-15*
*Update when test patterns change*
