# Report 4 — Detailed Implementation Plan

## Goal

Fix incremental graph boot/reset sequence to be spec-compliant, deterministic across restarts, and non-repairing under incompatible snapshot format.

## Plan

### Phase 1 — Error model and diagnostics

1. Add `InvalidSnapshotFormatError` in `backend/src/generators/incremental_graph/database/synchronize.js`.
2. Add `isInvalidSnapshotFormatError` type guard (`instanceof`).
3. Update `InvalidSnapshotReplicaError` formatting to render invalid values without forcing quotes around `undefined`.
4. Export new error + guard from:
   - `backend/src/generators/incremental_graph/database/synchronize.js`
   - `backend/src/generators/incremental_graph/database/index.js`

### Phase 2 — Reset bootstrap sequencing

1. Refactor `synchronizeNoLock()` to lazily open `rootDatabase`.
2. Non-reset path (`options.resetToHostname === undefined`):
   - keep existing checkpoint->sync->merge behavior,
   - open `rootDatabase` before checkpoint as before.
3. Reset path (`options.resetToHostname !== undefined`):
   - do **not** open `rootDatabase` before remote snapshot validation,
   - after repo sync, inside transaction callback:
     - validate `_meta/format` exists, parses as JSON, equals `xy-v2`,
     - only then validate `_meta/current_replica` exists/parses/is `x|y`,
     - import into a staged temporary live DB, scan `r/`, and scan `_meta`,
     - swap staged DB into live path only after successful full import (restore backup on swap failure).
4. Ensure `finally` only closes DB when it was actually opened.

### Phase 3 — Test updates and additions

1. Update reset bootstrap tests in `backend/tests/database_synchronize.test.js`:
   - incompatible format now throws `InvalidSnapshotFormatError`.
2. Add test that missing `_meta/current_replica` with valid format throws `InvalidSnapshotReplicaError` and message contains unquoted `undefined`.
3. Add test ensuring deterministic repeated reset failures with incompatible format and asserting live DB directory is still absent after each failure.
4. Add matrix-driven tests for multiple reset failure scenarios (format errors, replica errors, late scan/import errors) ensuring no healing occurs across repeated attempts.
5. Add swap-failure regression test to ensure existing live DB is restored when replacement fails mid-swap.

### Phase 4 — Validation commands

1. Run focused tests:
   - `npx jest backend/tests/database_synchronize.test.js --runInBand`
2. Run broad checks (as required workflow):
   - `npm test` (or note if pre-existing env/test runtime issue),
   - `npm run static-analysis`,
   - `npm run build`.

### Phase 5 — Finalization

1. Review changed files and line-level correctness.
2. Commit with message focused on boot-sequence determinism and format-first validation.
3. Create PR message via `make_pr` tool summarizing:
   - root cause,
   - behavior changes,
   - tests.

## Acceptance criteria

- Reset bootstrap with `_meta/format != xy-v2` fails with format-specific error before replica validation.
- Undefined replica value in errors is rendered as `undefined` (not `"undefined"`).
- Repeated startup attempts fail consistently under same invalid remote state.
- No live DB directory is created as a side effect of failed reset bootstrap validation.
