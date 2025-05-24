# Volodyslav’s Media Service Monorepo

A full-stack application for capturing photos via a browser camera, uploading them to a server, and transcribing audio files using OpenAI’s APIs. This repository follows a monorepo pattern, containing two primary workspaces:

  • **frontend**: A React + Vite single-page application (SPA) with Chakra UI
  • **backend**: An Express.js API server, file storage, and transcription endpoints

---

## Features

- **Camera interface** to capture and preview photos
- **Batch upload** of photos with a `request_identifier`
- **Mark-as-done** mechanism to prevent duplicate uploads
- **Transcription** of audio files (`.wav`, `.mp3`, etc.) using OpenAI’s `audio.transcriptions.create`
- **Static file serving** of the built frontend assets
- **Structured logging** via Pino + `pino-pretty`
- **Comprehensive tests** for both frontend (Jest + React Testing Library) and backend (Jest + SuperTest)

---

## Technology Stack

Frontend
- React 18, React Router v6
- Vite + ESBuild for fast bundling
- Chakra UI component library
- Jest & React Testing Library

Backend
- Node.js (ESM & CommonJS)
- Express.js HTTP server
- Multer for multipart/form-data file uploads
- Pino for JSON logging & `pino-pretty` for console output
- OpenAI SDK for audio transcription
- Jest & SuperTest for API testing

Tooling
- ESLint + `plugin:react/recommended` + `plugin:jest/recommended`
- Babel configured for JSX and modern JavaScript
- TypeScript used in `checkJs` mode to generate `.d.ts` types only
- Makefile and shell scripts for common tasks

---

## Getting Started

### Prerequisites

- Node.js v16+ (or latest LTS)
- npm v8+ (or Yarn v1/v2)
- Git CLI
- (... TODO: more)

### Environment

See [backend/tests/stubs.js](backend/tests/stubs.js) for an idea of how to set up the environment.
(TODO: provide actual instructions)

### Install & Build

```bash
git clone git@github.com:ottojung/volodyslav.git
cd volodyslav
npm install           # Install monorepo dependencies
npm run build         # Builds frontend and emits TS types
```

---

## Development Mode

#### Run Both Frontend & Backend

```bash
npm run dev
```

- Frontend Dev Server ▶ http://localhost:5173
- Backend API Server ▶ http://localhost:3000

_A proxy is configured so `/api/upload` requests from the frontend forward to the backend port._

#### Run Frontend Only

```bash
npm run dev -w frontend
```

Open your browser at http://localhost:5173. API calls to `/api/...` will 404 unless you also start the backend.

#### Run Backend Only

```bash
npm run dev -w backend
```

Backend listens on the `VOLODYSLAV_SERVER_PORT` you configured (default `3000`).

---

## Production Mode

### Build Frontend

```bash
npm run build -w frontend
```

Outputs static files to `frontend/dist`.

### Serve Frontend

```bash
npm run serve -w frontend
```

Serves the `dist` folder on port `4173` by default (Vite preview).

### Start Backend

```bash
npm run start -w backend
```

Launches the Express server in production mode.

### Combined Production

```bash
npm start
```

1. Builds the frontend
2. Serves the frontend at http://localhost:4173
3. Starts the backend API at http://localhost:3000

---

## Testing

Run all tests (backend + frontend):

```bash
npm test
```

- **Backend tests**: Jest + SuperTest in `backend/tests/`
- **Frontend tests**: Jest + React Testing Library in `frontend/tests/`

---

## Code Quality & Tooling

- **ESLint** with React & Jest plugins (root-level `.eslintrc.js`)
- **Babel**
  - Root config for backend
  - `.babelrc` in frontend for JSX
- **TypeScript**
  - Type-checks JS/JSX via `allowJs` + `checkJs`
  - Emits declaration files in `dist/types`

---

# License

This project is licensed under the **AGPL-3.0**.
See the [COPYING](./COPYING) file for full license terms.

---

# UID

This project's universally unique identifier is `81c3188c-d2cc-4879-a237-cdd0f1121346`.
