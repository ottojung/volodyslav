# Review feedback analysis: refresh in-memory replica after pointer writes

## Reported issue

`setCurrentReplicaPointer()` persists `_meta/current_replica` but does not refresh in-memory active-replica state. As a result, `currentReplicaName()` and active-replica accessors continue returning the pre-switch replica until process-level reopen.

## Why this is a real correctness bug

In `RootDatabaseClass`:

- `currentReplicaName()` returns `_cachedValueOfCurrentReplica` synchronously.
- `getSchemaStorage()` selects x/y storage from `_cachedValueOfCurrentReplica`.
- `setCurrentReplicaPointer()` currently writes persisted state but does not update `_cachedValueOfCurrentReplica`.

So after a successful pointer write:

1. persistent truth says active replica is new one,
2. in-memory truth still says old one,
3. same-process operations can read/write the wrong replica.

## Concrete impact path

The migration checkpoint flow (via `checkpointMigration`) renders snapshots based on `rootDatabase.currentReplicaName()`. If cutover happens in-process and cache is stale, post-cutover checkpoint rendering can still target the old replica. This can serialize incorrect checkpoint state and cause follow-up operations to run against stale replica data in the same process.

## Broader risk envelope

Any code path that relies on `currentReplicaName()` or `getSchemaStorage()` immediately after `setCurrentReplicaPointer()` is vulnerable to split-brain behavior (persisted pointer vs in-memory cache mismatch). This is especially risky in migration/synchronization flows that intentionally switch replicas without reopening DB handles.

## Expected invariant

After `setCurrentReplicaPointer(name)` resolves:

- `_meta/current_replica === name` (persisted),
- `_cachedValueOfCurrentReplica === name` (in-memory),
- active identifier lookup reflects `name` replica global state.

Without these, active-replica APIs are not linearizable relative to pointer updates.
