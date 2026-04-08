# Report 4 — Detailed Implementation Plan (Final, Unambiguous)

## Mandatory policy decisions

This plan **explicitly does not preserve backward compatibility** for legacy database formats. `xy-v1` and any non-`xy-v2` root format are unsupported and must crash at startup.

This plan also assumes **Volodyslav has never been deployed** for compatibility planning purposes; therefore no legacy compatibility shims, transitional flags, dual-write windows, or rollout guards are allowed.

## Final design to implement

### Step 1 — Add explicit error type for missing reset hostname branch

File: `backend/src/gitstore/working_repository.js`

Implement:
- `ResetToHostnameNotFoundError`
- type guard `isResetToHostnameNotFoundError`

Behavior:
- when `synchronize(..., { resetToHostname })` is requested, run a preflight git check:
  - `git ls-remote --heads -- <remotePath> refs/heads/<hostname>-main`
- if output is empty, throw `ResetToHostnameNotFoundError`.
- propagate this typed error unchanged (do not wrap as generic `WorkingRepositoryError`).

This resolves ambiguity between expected first-host condition and genuine sync failures.

### Step 2 — Enforce startup bootstrap ordering in lifecycle

File: `backend/src/generators/interface/lifecycle.js`

Implement function: `bootstrapDatabaseIfMissing(capabilities)`.

Exact algorithm:

1. Compute live DB path via `pathToLiveDatabase(capabilities)`.
2. If directory exists: return immediately.
3. Else read hostname from `capabilities.environment.hostname()`.
4. Try `synchronizeNoLock(capabilities, { resetToHostname: hostname })`.
5. If success: return.
6. If error is `ResetToHostnameNotFoundError`:
   - log informational fallback message,
   - run `synchronizeNoLock(capabilities)`.
7. Any other error: rethrow (startup fails).

Integration point:
- Call `bootstrapDatabaseIfMissing(capabilities)` inside the existing exclusive-mode block in `internalEnsureInitialized`, before `internalEnsureInitializedWithMigration(...)`.

### Step 3 — Keep strict structural/version rules unchanged

No compatibility relaxation is allowed.

- Existing format check in `makeRootDatabase` remains strict (`xy-v2` only).
- Existing migration execution path remains mandatory on version mismatch.

### Step 4 — Documentation deliverables

Create/update the following documents:

1. `docs/database-boot-sequence.md`
   - conceptual explanation
   - detailed step-by-step runtime behavior
   - mermaid flowchart and state diagram
   - explicit failure semantics

2. `docs/report1.md`
   - issue understanding and failure analysis

3. `docs/report2.md`
   - codebase mapping and relevant module behavior

4. `docs/report3.md`
   - strategy fit + alternatives comparison

5. `docs/report4.md` (this file)
   - final implementation plan with all ambiguities resolved

### Step 5 — Validation plan (fixed, no alternatives)

Run in this order:

1. Focused tests:
   - `backend/tests/working_repository.reset_mode.test.js`
2. Full required workflow:
   - `npm install`
   - `npm test`
   - `npm run static-analysis`
   - `npm run build`

No optional paths; this sequence is final.

## Expected outcomes

- Missing live DB now always follows deterministic bootstrap policy.
- Reset-to-hostname missing branch is treated as expected first-host condition, not generic failure.
- Existing DB format mismatch crashes reliably.
- Version mismatch migration runs during initialization.
- No backward-compatibility code paths are introduced.
