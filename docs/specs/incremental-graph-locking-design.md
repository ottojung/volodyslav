# Incremental Graph Locking Design

## Status

This document describes the locking model that the incremental graph MUST.

## Summary

The target behavior is:

1. Daytime activity (`getValue()`, `getFreshness()`, `listMaterializedNodes()`,
   `invalidate()`) is exclusive with nighttime observation (`pull()`), but not
   exclusive with other daytime activities.
2. Inspection reads such as `getValue()` and `listMaterializedNodes()` are
   allowed to run concurrently with `invalidate()`.
3. Nighttime observation (`pull()`) is exclusive with daytime activity.
4. Observations of the same concrete node must not coexist (telescope
   mutex).
5. Observations of different concrete nodes may coexist.
6. Migration and replica cutover are exclusive with all graph activity
   (daytime, nighttime) and with journal queries.
7. Transaction commits for the same replica are serialized (the commit
   mutex is per-replica, not global, so commits to different replicas
   proceed concurrently).
8. Journal queries observe a consistent journal snapshot for one stable
   replica, serialized with all journal-writing operations.

## Sleeper Primitives

The design is based on two sleeper primitives:

### `withMutex(key, procedure)`

This is the existing exclusive mutex:

- at most one caller per key runs at a time;
- other callers queue in FIFO order.

It remains the right primitive for **per-node pull exclusion**.

### `withModeMutex(key, mode, procedure)`

This is a grouped lock:

- callers with the same `(key, mode)` may run concurrently;
- callers with the same `key` but a different `mode` are mutually exclusive;
- queued callers are served in FIFO **mode groups** so that a later caller in
  the current mode cannot skip ahead of an earlier conflicting mode.

This is the right primitive for **global graph phases** where we want
`nighttime`/`daytime` exclusion without forcing all pulls to serialize with each
other.

## Lock Keys

The implementation SHOULD derive two families of keys.

### 1. Graph activity key

There is exactly one global key:

- `GRAPH_ACTIVITY_KEY`

This key is acquired through `withModeMutex`.

Three modes are defined on `GRAPH_ACTIVITY_KEY`:

- `"daytime"` for `invalidate()` and inspection reads;
- `"nighttime"` for all pull activity;
- `"holiday"` for migration and replica cutover (exclusive with all other modes).

Because same-mode holders are compatible, many invalidates may overlap, and many
pulls may overlap. Because different modes are incompatible, no pull may overlap
any invalidate or inspection read. `"holiday"` is exclusive with every other mode.

### 2. Per-node pull key

There is one exclusive key per concrete node:

- `PULL_NODE_KEY(nodeKeyString)`

This key is acquired through `withMutex`.

It is used only by pull operations, and only for the concrete node currently
being pulled. This is what serializes same-node pulls without blocking pulls on
different nodes.

## Operation Protocol

### `invalidate(node)`

1. Acquire `daytimeActivity(...)` (internally `withModeMutex(GRAPH_ACTIVITY_KEY, "daytime", ...)`).
2. Run the invalidation logic.
3. Release the mode lock.

No per-node mutex is needed.

### inspection read

1. Acquire `daytimeActivity(...)` (internally `withModeMutex(GRAPH_ACTIVITY_KEY, "daytime", ...)`).
2. Read the requested inspection data.
3. Release the mode lock.

No per-node mutex is needed.

### `pull(node)`

1. Acquire `nighttimeActivity(...)` (internally `withModeMutex(GRAPH_ACTIVITY_KEY, "nighttime", ...)`).
2. Acquire `telescopeActivity(nodeKeyString, ...)` (internally
   `withMutex(PULL_NODE_KEY(nodeKeyString), ...)`).
3. Open a transaction (acquires `darkroomActivity` for the active replica).
4. Pull dependencies and compute/write back the node value while holding
    the graph-activity mode lock, the per-node mutex, and the darkroom lock.
5. Flush the batch and release the darkroom lock.
6. Release the per-node mutex.
7. Release the graph-activity mode lock.

The darkroom lock is per-replica, so commits to different replicas never
contend. Nested pulls (dependencies) reuse the same graph-activity mode
("nighttime") but acquire their own per-node mutex for each dependency node.
Each nested pull creates its own Transaction (acquiring its own darkroom
lock) and submits its batch independently. This matches the volatile-
consistency spec: every call to pullNode is structurally identical,
whether top-level or nested.

### `possibleMaybeChanges({ since, to })`

The correctness requirement is that `possibleMaybeChanges` must observe a single consistent journal snapshot for one stable replica (see `docs/specs/incremental-graph-journal-api.md` REQ-JA-CONC-01). This specification describes two valid implementation strategies.

#### Strategy A: darkroom-lock-held-for-full-scan

1. Acquire the darkroom lock for the active replica.
2. Scan the journal storage, collecting matching `PossibleNodeChange` values into an array.
3. Release the darkroom lock and return the array.

Every journal-writing operation (pull commits, invalidate commits, migration actions, sync actions, compaction) acquires the darkroom lock for its durable batch write. Holding the darkroom lock for the full scan therefore serializes the scan with all durable journal mutations, satisfying REQ-JA-CONC-01.

#### Strategy B: storage-snapshot-under-serialization

1. Acquire the relevant serialization lock (e.g., darkroom lock for the active replica).
2. Capture a stable storage snapshot plus the current `last_journal_index`.
3. Release the serialization lock.
4. Scan the storage snapshot, collecting matching `PossibleNodeChange` values into an array.
5. Return the array.

This strategy is valid provided the storage layer supports consistent snapshots and the snapshot is captured under the same serialization discipline used for all journal structural mutations (REQ-JA-CONC-04).

#### Common constraints

Both strategies must ensure stable replica selection: replica cutover must either be excluded while the journal snapshot is acquired or must provide a stable snapshot/handle for the selected replica (REQ-JA-CONC-05).

`possibleMaybeChanges` does not acquire the `GRAPH_ACTIVITY_KEY` mode lock. Ordinary daytime and nighttime graph operations are not globally blocked by journal queries — only their durable darkroom transaction/write section is serialized with the journal scan.

### `migration / replica cutover`

1. Acquire `holidayActivity(...)`.
2. Run the migration or cutover.
3. Release the holiday lock.

The two-step acquisition (`MUTEX_KEY` → `GRAPH_ACTIVITY_KEY("holiday")`)
is deadlock-free because nighttime and daytime operations only ever acquire
`GRAPH_ACTIVITY_KEY`.

The computor stays inside the pull critical section. This is safe because the
critical section is no longer graph-global: other pulls may still proceed on
other nodes, while invalidates and inspection reads are excluded.

## Why This Matches the Requested Semantics

### Invalidates with invalidates

Both use `daytimeActivity(...)`, so they are compatible.

### Invalidates with reads

Both use `daytimeActivity(...)`, so they are compatible.

### Pulls with reads or invalidates

Nighttime observations (`pull()`) use mode `"nighttime"` while reads and invalidates
use mode `"daytime"`. Those modes conflict, so these operations are
mutually exclusive.

### Pulls on the same node

They contend on the same `PULL_NODE_KEY(nodeKeyString)`, so they serialize.

### Pulls on different nodes

They share the compatible global `"nighttime"` mode and use different per-node mutex
keys, so they may proceed concurrently.

### Journal queries

`possibleMaybeChanges` must observe a single consistent journal snapshot for one stable replica (REQ-JA-CONC-01). It does not acquire the `GRAPH_ACTIVITY_KEY` mode lock, so it does not interfere with ordinary daytime or nighttime graph activity (reads, invalidations, or pulls on different nodes).

A conforming implementation may satisfy this requirement by holding the active replica's darkroom lock for the full journal scan, or by acquiring a storage-level snapshot under the same serialization discipline (see `docs/specs/incremental-graph-journal-api.md` for the full concurrency specification). All journal-writing operations — pull commits, invalidate commits, migration actions, sync actions, and compaction — commit through the darkroom lock, which provides the serialization boundary.

## Deadlock Discipline

The implementation MUST keep this acquisition discipline:

1. acquire the graph activity mode lock first;
2. acquire any per-node pull mutexes after that;
3. never acquire `"daytime"` while holding a per-node pull mutex.

Inspection reads, invalidates, and journal queries only take the global mode lock or the darkroom lock, so they cannot participate in a node-level cycle.

Pulls may recursively pull dependencies while already holding pull locks. The
incremental graph is a DAG, so any wait edge from node `A` to node `B` implies
that `A` depends on `B`. A deadlock cycle would therefore imply a dependency
cycle, which the graph constructor already rejects.

## Why `withoutMutex` Must Not Return

`withoutMutex` encoded a very different strategy: temporarily leave the critical
section and try to restore it later. That is fundamentally the wrong shape for
the new invariants because:

- it allows a pull to overlap an invalidate;
- it allows two same-node pulls to race through the same recomputation;
- it requires the caller to reason about a lock gap outside the type and API
  structure of the primitive itself.

The safer replacement is not a more careful "drop and reacquire" helper. The
safer replacement is a pair of primitives that directly express the intended
compatibility rules.
