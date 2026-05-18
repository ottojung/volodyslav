# Strategy for addressing review: active replica cache refresh after pointer write

## Principle

Treat replica-pointer updates as an atomic state transition at the `RootDatabase` abstraction boundary: once the API call resolves, all read APIs must observe the new active replica.

## Strategy

1. **Single-source transition API**
   Keep `setCurrentReplicaPointer(name)` as the single mutator for active replica pointer state.

2. **Persist-first, then update in-memory state**
   - First persist `_meta/current_replica`.
   - If persist fails, throw `SwitchReplicaError` and keep in-memory state unchanged.
   - If persist succeeds, update in-memory active replica cache immediately.

3. **Refresh dependent active-state caches**
   Refresh active identifier lookup right after in-memory pointer update, so identifier translation also tracks the new replica.

4. **Preserve explicit-replica APIs**
   `schemaStorageForReplica(name)` remains unaffected (explicit access), while `getSchemaStorage()` and `currentReplicaName()` become immediately consistent after pointer switch.

5. **Test the invariant directly**
   Add/adjust tests to verify immediate same-instance behavior (without close/reopen):
   - `currentReplicaName()` reflects new value right after switch.
   - `getSchemaStorage()` reflects switched active replica.

6. **Regression validation in migration/sync flows**
   Run focused migration/sync tests plus full suite/static-analysis/build to ensure no ordering regressions.

## Why this is principled

- It enforces linearizable semantics for pointer mutation.
- It removes transient split-brain state from a single process.
- It keeps responsibilities local to `RootDatabase` (no caller-side reopen workaround).
- It aligns the active key-translation lookup with the active replica pointer.
