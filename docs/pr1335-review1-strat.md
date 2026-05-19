# Strategy to Address PR #1335 Review Feedback #1

## Principles

1. **Single source of truth**
   - Keep all active-replica runtime derivations in one `_computed` object.

2. **Atomic cutover semantics**
   - No live-state mutation before all candidate parts are built and persistence succeeds.

3. **On-demand inactive access**
   - Derive inactive replica sublevels/storages from `db` and replica name when needed.

4. **Behavioral compatibility**
   - Preserve existing public API and migration call patterns.

5. **Test-first validation loop**
   - Run focused tests for replica and migration behavior.
   - Run full checks (`npm test`, `npm run static-analysis`, `npm run build`) and iterate until green.

## Strategic approach

### A. Collapse mutable state
Replace parallel per-replica mutable fields with one mutable bundle `_computed`.

### B. Introduce pure derivation helpers
Use helpers like:
- `replicaNamespaceSublevel(name)`
- `replicaGlobalSublevel(name)`
- `schemaStorageForReplica(name)`

These should derive from `db` every call and avoid long-lived dual caches.

### C. Refactor switch flow into staged transaction
Implement `setCurrentReplicaPointer(name)` as:
1. validate input
2. derive candidate namespace/global handles
3. build candidate schema storage
4. load candidate identifier lookup
5. persist `_meta/current_replica`
6. single assignment to `_computed`

### D. Preserve clear semantics
`clearReplicaStorage(name)` should clear that namespace and, only if it is active, rebuild `_computed` for that active replica.

### E. Reconcile tests and docs
- Update any tests that depended on previous internal caching behavior.
- Document architectural rationale and invariants.
