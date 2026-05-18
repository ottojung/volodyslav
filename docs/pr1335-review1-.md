# PR #1335 Review Feedback #1 — Problem Analysis

## Feedback summary
The reported issue is that `setCurrentReplicaPointer()` writes `_meta/current_replica`, but does **not** refresh in-memory active-replica state. As a result, in the same process:

- `currentReplicaName()` can continue returning the stale pre-switch replica.
- `getSchemaStorage()` can keep returning the stale pre-switch storage handle.

This can produce wrong behavior immediately after cutover, before any reopen.

## Where it manifests
In `backend/src/generators/incremental_graph/database/root_database.js`:

- `setCurrentReplicaPointer(name)` validates and persists to `_rootMetaSublevel.put('current_replica', name)`.
- It does **not** assign `this._cachedValueOfCurrentReplica = name`.

Meanwhile:

- `currentReplicaName()` returns `this._cachedValueOfCurrentReplica`.
- `getSchemaStorage()` branches off `this._cachedValueOfCurrentReplica`.

So pointer durability and runtime behavior diverge until reopen.

## Why this is serious
The migration checkpoint flow composes behavior in one process and expects post-cutover operations to observe the new active replica immediately.

Specifically, if cutover occurs during `checkpointMigration` callback and then snapshot rendering queries `rootDatabase.currentReplicaName()`, it may still resolve the old replica and render/snapshot stale data.

That creates two classes of risk:

1. **Incorrect checkpoint artifacts**
   - Post-migration snapshot may represent pre-cutover replica state.
2. **Follow-up stale operations**
   - Subsequent operations in same process can read/write through stale storage route.

## Root cause
The core invariant is currently broken:

> After a successful active-replica pointer update, all in-memory routing state must atomically reflect the same replica.

The code currently updates only persistent metadata, not in-memory routing cache.
