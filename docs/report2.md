# Report 2 — Codebase Understanding Focused on This Issue

## Architectural map

### Main subsystems involved

1. **Generators interface lifecycle**
   - `backend/src/generators/interface/lifecycle.js`
   - owns lazy initialization and synchronization orchestration.

2. **IncrementalGraph database core**
   - `backend/src/generators/incremental_graph/database/root_database.js`
   - opens LevelDB, validates format marker, manages active replica pointer.

3. **Synchronization pipeline**
   - `backend/src/generators/incremental_graph/database/synchronize.js`
   - checkpoint render -> git synchronize -> optional reset scan -> host-by-host graph merge.

4. **Git working repo synchronization backend**
   - `backend/src/gitstore/working_repository.js`
   - clone/pull/push/reset-to-hostname behavior.

5. **Migration runner**
   - `backend/src/generators/incremental_graph/migration_runner.js`
   - checks replica meta version and performs migration transaction on mismatch.

## Startup call chain (relevant)

- `server.ensureStartupDependencies()` calls `capabilities.interface.ensureInitialized()`.
- `Interface.ensureInitialized()` calls lifecycle `internalEnsureInitialized()`.
- Lifecycle opens root DB and executes migration pathway.

This call chain is exactly where boot sequence policy must live.

## Current data layout model

### Live store
- path: `<workingDirectory>/generators-leveldb`
- root metadata:
  - `_meta/format` expected `xy-v2`
  - `_meta/current_replica` expected `x|y`
- replica sublevels: `x`, `y`

### Git-rendered checkpoint store
- path: `<workingDirectory>/generators-database/rendered`
- includes rendered active replica under `r/` and metadata under `_meta/`
- synchronization and migration snapshots are done through this layer.

## Existing guarantees already present

1. **Format mismatch crash**
   - root open throws when `_meta/format !== xy-v2`.
2. **Replica pointer validation**
   - throws on missing/invalid `_meta/current_replica`.
3. **Version-based migration**
   - migration runner compares stored meta version with current app version and migrates when different.

## Gap found (root cause of issue)

Before this fix, startup lacked a deterministic “missing live DB” bootstrap policy.

The system had reset-to-hostname support in sync APIs, but this was not wired as a strict pre-open startup branch, and there was no explicit typed error for “hostname branch absent,” preventing reliable fallback to normal sync.

## Repository-wide patterns respected

- capabilities pattern for side effects (git/filesystem/environment/logger)
- JSDoc typedef/type-guard conventions
- fail-fast behavior on structural mismatch
- explicit lock/exclusive-mode around initialization/sync paths

## Why this issue is localized

No frontend/data-contract migration is needed. The failure is lifecycle orchestration in backend startup and remote-reset error classification.
