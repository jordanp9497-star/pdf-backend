# Technology Stack

**Analysis Date:** 2026-01-15

## Languages

**Primary:**
- TypeScript 5.9.x - Expo / React Native mobile app: `Medicalia/medical-assistant/**/*.{ts,tsx}`, `Medicalia/medical-assistant/package.json`
- JavaScript (ESM) - Node/Express backend: `pdf-backend/index.js`, `pdf-backend/routes/*.js`, `pdf-backend/package.json`

**Secondary:**
- Python 3.11 - Optional OpenCV preprocessing service: `pdf-backend/opencv-preprocess/app.py`, `pdf-backend/opencv-preprocess/Dockerfile`

## Runtime

**Environment:**
- Node.js - Required for both the Expo app tooling and the `pdf-backend` server (no pinned version detected)
- Expo runtime (Expo SDK ~54) - Mobile app runtime via Expo Go / dev client / production build: `Medicalia/medical-assistant/package.json`
- Python 3.11 (Docker) - OpenCV microservice runtime: `pdf-backend/opencv-preprocess/Dockerfile`

**Package Manager:**
- npm - Used by both JS/TS projects
  - Lockfile: `Medicalia/medical-assistant/package-lock.json`
  - Lockfile: `pdf-backend/package-lock.json`
- pip - Python microservice dependencies
  - Requirements: `pdf-backend/opencv-preprocess/requirements.txt`

## Frameworks

**Core:**
- Expo Router (~6) - File-based routing/navigation: `Medicalia/medical-assistant/package.json`, `Medicalia/medical-assistant/app/_layout.tsx`
- React Navigation (native + bottom tabs) - Navigation primitives under Expo Router: `Medicalia/medical-assistant/package.json`
- Express 4.18 - HTTP API server: `pdf-backend/package.json`, `pdf-backend/index.js`
- FastAPI 0.104 + Uvicorn 0.24 - Python image preprocessing service: `pdf-backend/opencv-preprocess/requirements.txt`

**Testing:**
- Not detected (no Jest/Vitest/Detox/etc. configured)

**Build/Dev:**
- EAS Build - Mobile builds (development/preview/production): `Medicalia/medical-assistant/eas.json`
- TypeScript compiler - `Medicalia/medical-assistant/tsconfig.json`
- ESLint (Expo flat config) - `Medicalia/medical-assistant/eslint.config.js`

## Key Dependencies

(Only the most stack-defining dependencies; see each `package.json` for full lists.)

**Critical:**
- `expo` (~54) - Mobile app SDK/runtime: `Medicalia/medical-assistant/package.json`
- `expo-router` (~6) - Routing: `Medicalia/medical-assistant/package.json`
- `react` (19.1) + `react-native` (0.81) - UI/runtime: `Medicalia/medical-assistant/package.json`
- `@react-native-async-storage/async-storage` - Local persistence: `Medicalia/medical-assistant/package.json`
- `pdf-lib` + `pdfjs-dist` - PDF processing on device: `Medicalia/medical-assistant/package.json`
- `express` - Backend server: `pdf-backend/package.json`
- `multer` (memory uploads) - Multipart/form-data upload parsing: `pdf-backend/package.json`, `pdf-backend/index.js`
- `pdf-parse` - Server-side PDF text extraction: `pdf-backend/package.json`
- `openai` - LLM summarization: `pdf-backend/package.json`, `pdf-backend/index.js`
- `opencv-python-headless` + `numpy` - Image preprocessing: `pdf-backend/opencv-preprocess/requirements.txt`

**Infrastructure:**
- `dotenv` - Backend env loading: `pdf-backend/package.json`, `pdf-backend/index.js`
- `cors` - Backend CORS middleware: `pdf-backend/package.json`, `pdf-backend/index.js`

## Configuration

**Environment:**
- Mobile app uses Expo config (`expo.extra`) as a stable runtime config source (especially for release builds):
  - `Medicalia/medical-assistant/app.json`
  - `Medicalia/medical-assistant/config/env.ts`
  - `Medicalia/medical-assistant/config/api.ts`
- EAS build profiles inject env vars (preview/production): `Medicalia/medical-assistant/eas.json`
- Backend reads `.env` via dotenv at startup: `pdf-backend/index.js`
- Python microservice is configured primarily via Dockerfile (no env vars required detected): `pdf-backend/opencv-preprocess/Dockerfile`

**Build:**
- Expo app configuration: `Medicalia/medical-assistant/app.json`, `Medicalia/medical-assistant/eas.json`
- TypeScript compiler config: `Medicalia/medical-assistant/tsconfig.json`
- ESLint config: `Medicalia/medical-assistant/eslint.config.js`

## Platform Requirements

**Development:**
- Node.js + npm (for both subprojects)
- Expo tooling (Expo CLI via `npx expo`, plus platform toolchains for device builds)
- Optional: Docker (to run/build the OpenCV preprocessing service)

**Production:**
- Mobile app: distributed via EAS builds (App Store / Play Store): `Medicalia/medical-assistant/eas.json`
- Backend: Node hosting (deployment target inferred via app config pointing to Railway): `Medicalia/medical-assistant/app.json`
- OpenCV preprocessing: containerized service (FastAPI/Uvicorn): `pdf-backend/opencv-preprocess/Dockerfile`

---

*Stack analysis: 2026-01-15*
*Update after major dependency changes*
