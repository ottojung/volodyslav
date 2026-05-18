# PR #1335 Review Feedback #1 — Strategy

## Goal
Restore a strict consistency guarantee between persisted active-replica pointer and in-memory routing state after `setCurrentReplicaPointer()`.

## Strategy principles

1. **Single-operation coherence**
   - Treat pointer update as a state transition that must leave the object coherent at return time.
   - On success, any immediate caller of `currentReplicaName()`, `getSchemaStorage()`, and identifier lookup consumers must observe the new active replica.

2. **Fail-safe ordering**
   - Persist first, then refresh caches.
   - If persistence fails, in-memory state must remain unchanged.
   - If cache refresh fails after persistence, surface the error loudly (do not silently continue with stale cache).

3. **Minimal surface-area change**
   - Fix behavior in `RootDatabase` where the invariant is owned.
   - Avoid scattering cache-sync work across migration/callers.

4. **Regression prevention via tests**
   - Add direct behavior tests that verify immediate in-process cutover semantics (without reopen).
   - Keep existing persistence-across-reopen test to ensure durable behavior still holds.

## Chosen approach
- Update `setCurrentReplicaPointer(name)` to:
  1) persist `_meta/current_replica`,
  2) assign `_cachedValueOfCurrentReplica = name`,
  3) refresh active identifier lookup from the newly active replica's global sublevel.

This aligns all active-replica-dependent APIs behind one coherent state transition.
