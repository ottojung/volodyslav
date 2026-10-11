
# Volodyslav Media Service

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
sh scripts/install /usr/local

# Set all required environment variables.
volodyslav start
```

---

## Testing

Run all tests (backend + frontend):

```bash
npm test
npm run static-analysis
```

### Worker count

The suite runs at one worker unless `JEST_MAX_WORKERS` says otherwise. That
variable accepts a whole number of workers between 1 and what this host reports
available to one process, and nothing else: every other value is refused with a
message naming it, by every way of starting Jest in this repository.

Two channels reach the worker count from outside the grammar. Both are described
here rather than refused, because Jest offers no hook for either:

- Jest's command line outranks every configuration value. `--maxWorkers`, `-w`,
  `--runInBand`, `--config` and `--projects` named there run the suite outside
  the counts this repository validates. Nothing here names one, and
  `backend/tests/worker_count_gate.test.js` fails if a package script, workflow,
  shell script, Dockerfile, Makefile target or document does.
- A configuration written as JSON text on the command line replaces this
  repository's configurations instead of adding to them, so no configuration here
  is read and nothing here can refuse it.

One worker is slow rather than wrong. It removes the oversubscription that turned
wall-clock budgets into timeouts, and it does not make the suite deterministic on
a host shared with other work.

---

# License

This project is licensed under the **AGPL-3.0**.
See the [COPYING](./COPYING) file for full license terms.

---

# UID

This project's universally unique identifier is `81c3188c-d2cc-4879-a237-cdd0f1121346`.
