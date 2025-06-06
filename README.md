
# Volodyslav’s Media Service

A full-stack application for capturing photos via a browser camera, uploading them to a server, and transcribing audio files using OpenAI's APIs. This repository follows a monorepo pattern.

---

## Technology Stack

Main frontend dependencies:

- React
- Vite
- Chakra UI component library
- Jest & React Testing Library

Main backend dependencies:

- Node.js
- Express.js HTTP server
- Pino for JSON logging & `pino-pretty` for console output
- OpenAI SDK for audio transcription
- Jest & SuperTest for API testing

Tooling
- ESLint + `plugin:react/recommended` + `plugin:jest/recommended`
- TypeScript used in `checkJs` mode for type checking; declaration files are emitted as a side effect
- Makefile and shell scripts for common tasks

---

## Development Mode

#### Run Both Frontend & Backend

```bash
sh scripts/run-development-server
```

- Frontend Dev Server ▶ http://localhost:5173
- Backend API Server ▶ http://localhost:3000

---

## Production Mode

```bash
# Set all required environment variables.
sh scripts/update-and-install /usr/local
volodyslav start
```

---

## Testing

Run all tests (backend + frontend):

```bash
npm test
npm run static-analysis
```

---

# License

This project is licensed under the **AGPL-3.0**.
See the [COPYING](./COPYING) file for full license terms.

---

# UID

This project's universally unique identifier is `81c3188c-d2cc-4879-a237-cdd0f1121346`.
