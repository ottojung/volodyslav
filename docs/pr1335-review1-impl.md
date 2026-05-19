# Detailed Implementation Plan for PR #1335 Review Feedback #1

## 1) Refactor internal state model in `root_database.js`

- Remove per-replica cached fields:
  - `_xNamespaceSublevel`, `_yNamespaceSublevel`
  - `_xGlobalSublevel`, `_yGlobalSublevel`
  - `_xSchemaStorage`, `_ySchemaStorage`
  - `_cachedValueOfCurrentReplica`
  - `_identifierLookup`
- Add/standardize `_computed` as the active runtime bundle.

## 2) Add replica-derivation helpers

- Implement:
  - `replicaNamespaceSublevel(name)`
  - `replicaGlobalSublevel(name)`
- Keep validation local to replica-sensitive entry points so invalid names still throw `InvalidReplicaPointerError`.

## 3) Rebuild active initialization path

- Constructor should:
  - derive active namespace/global from initial replica name
  - build active schema storage
  - initialize empty lookup
  - assign `_computed`

## 4) Make `setCurrentReplicaPointer` atomic

- Validate `name`.
- Build all candidate parts locally.
- Persist pointer to `_meta/current_replica`.
- Assign `_computed` once.
- Wrap failures in `SwitchReplicaError`.

## 5) Update dependent methods

- `currentReplicaName`, `getSchemaStorage`, `getGlobalVersion`, `setGlobalVersion`, and lookup helpers should read/write through `_computed`.
- `schemaStorageForReplica(name)` should derive on demand and return a fresh schema storage.
- `clearReplicaStorage(name)` should clear derived namespace; if active, rebuild `_computed` from cleared namespace.

## 6) Verification

- Focused tests:
  - database replica-switch and storage tests.
  - migration/sync tests touching `schemaStorageForReplica` and switch cutover semantics.
- Full checks:
  - `npm test`
  - `npm run static-analysis`
  - `npm run build`
- Fix regressions and rerun until all pass.
