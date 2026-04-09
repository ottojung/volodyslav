# Report 2 — Codebase Understanding Focused on the Issue

## Relevant architecture slices

### 1) Startup orchestration

- `backend/src/generators/interface/lifecycle.js`
- `internalEnsureInitialized()` decides bootstrap path by checking live DB directory existence.
- If live DB missing, it runs `internalBootstrap()`.
- After bootstrap decision, it always proceeds to `internalEnsureInitializedWithMigration()` which opens root DB via `getRootDatabase()` and runs migration checks.

### 2) Root database structural contract

- `backend/src/generators/incremental_graph/database/root_database.js`
- `makeRootDatabase()` opens LevelDB and enforces:
  - fresh DB: writes `_meta/format = xy-v2` and `_meta/current_replica = x`,
  - existing DB: format must equal `xy-v2`,
  - existing DB: current replica must be `x|y`.

### 3) Reset/bootstrap synchronization path

- `backend/src/generators/incremental_graph/database/synchronize.js`
- `synchronizeNoLock()` performs checkpoint/sync/merge behavior.
- For `resetToHostname`, it synchronizes checkpoint repository and scans rendered snapshot (`rendered/r` and `rendered/_meta`) back into live LevelDB.

## Why issue manifests in this architecture

### A) Validation logic in reset path was incomplete

In reset mode, snapshot ingestion validated `_meta/current_replica`, but did not validate `_meta/format` first. This diverges from the structural-check sequence expected by spec.

### B) Live DB side effects happened too early in reset path

`rootDatabase` was opened at the beginning of `synchronizeNoLock()`, before reset snapshot validation. On first open, this can initialize local metadata, creating durable local state even when reset fails.

### C) Bootstrap branching depends on directory existence

`internalEnsureInitialized()` uses live DB directory presence to choose whether to bootstrap. Once premature local initialization has created that directory, subsequent starts bypass reset bootstrap entirely.

## Existing test coverage (before fix)

### Present

- `backend/tests/database_synchronize.test.js` already covered invalid/missing `_meta/current_replica` in reset mode.
- `backend/tests/interface.test.js` covered bootstrap path selection V3/V4.
- `backend/tests/database.test.js` covered root DB format/replica validation for direct open.

### Missing

- format-first behavior in reset snapshot validation,
- deterministic repeated-failure behavior for reset bootstrap with incompatible remote format,
- message rendering correctness for undefined in snapshot-replica errors.

## Constraints observed in this repo

- Capability pattern is used for filesystem/git/db operations.
- Error classes and `instanceof`-based type guards are used consistently.
- Encapsulation is module-based; database public exports route through `database/index.js`.
- Boot-sequence document (`docs/database-boot-sequence.md`) acts as behavior contract.

## Conclusion

The bug is not a single conditional; it is a startup-boundary sequencing issue across lifecycle bootstrap and reset synchronization flow. Correct fix point is the reset branch inside `synchronizeNoLock()`, with additional test guarantees around restart determinism.
