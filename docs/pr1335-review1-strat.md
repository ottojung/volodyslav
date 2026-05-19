# PR #1335 Review 1 — Refactor Strategy

## Guiding principles
1. **Single source of truth**: only `_computed` represents active runtime replica state.
2. **Atomic commit point**: replica switches mutate active state exactly once, after all candidate computation + persistence succeeds.
3. **On-demand inactive access**: derive inactive handles from `db` and replica name when needed.
4. **No behavior shortcuts**: keep two-namespace semantics and migration capabilities intact.

## Strategy steps
1. Replace fragmented mutable fields with `_computed` bundle.
2. Introduce deterministic helpers:
   - `replicaNamespaceSublevel(name)`
   - `replicaGlobalSublevel(name)`
   - `schemaStorageForReplica(name)` from helpers.
3. Refactor read/write methods (`getSchemaStorage`, global version methods, lookup methods) to use `_computed`.
4. Refactor `setCurrentReplicaPointer(name)` to fully stage candidate bundle before persisting pointer and committing `_computed`.
5. Keep `clearReplicaStorage(name)` compatible with atomic model by rebuilding active `_computed` only when cleared replica is active.
6. Validate with static-analysis and full tests, then iterate on failures.

## Expected outcomes
- Eliminates divergence between active pointer and related cached handles.
- Makes switch logic transactional by structure.
- Preserves ability to work with both physical replicas.
