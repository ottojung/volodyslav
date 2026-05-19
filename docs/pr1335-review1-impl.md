# PR #1335 Review 1 — Detailed Implementation Plan

## 1) Data model updates in `root_database.js`
- Remove mutable fields for:
  - cached replica name
  - x/y namespace/global sublevels
  - x/y schema storages
  - standalone active identifier lookup
- Add `_computed` as the only mutable active-state reference.

## 2) Constructor rewrite
- Keep stable fields: `db`, `_rootMetaSublevel`, `version`, `_seed`.
- Build initial active bundle from `currentReplicaName`:
  - namespace/global handles from helper methods
  - schema storage from `buildSchemaStorage`
  - empty identifier lookup as initial in-memory map

## 3) Helper methods
- Add helper methods for per-replica derived handles:
  - `replicaNamespaceSublevel(name)`
  - `replicaGlobalSublevel(name)`
- Keep `schemaStorageForReplica(name)` as on-demand builder using helpers.

## 4) Active-access method rewrites
- `currentReplicaName()` returns `_computed.replicaName`.
- lookup getters/setters and translation methods use `_computed.identifierLookup`.
- `getSchemaStorage`, `getGlobalVersion`, `setGlobalVersion` use `_computed` fields.

## 5) Atomic switch rewrite
- In `setCurrentReplicaPointer(name)`:
  1. validate
  2. derive candidate sublevels
  3. build candidate schema storage
  4. load candidate identifier lookup
  5. persist `current_replica`
  6. assign `_computed` once
- Preserve `SwitchReplicaError` wrapping behavior.

## 6) Clear-storage behavior
- Clear derived namespace for target replica.
- If cleared replica is active, rebuild and replace `_computed` to reset storage closure state and refresh active lookup.

## 7) Validation loop
- Run:
  - `npm install`
  - `npm test`
  - `npm run static-analysis`
  - `npm run build`
- Fix any failures until all pass.
