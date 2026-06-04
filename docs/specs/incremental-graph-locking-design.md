# Incremental Graph Locking Design

## Status

This document describes the locking model that the incremental graph MUST.

## Summary

The target behavior is:

1. `invalidate()` is exclusive with any `pull()`, but not with other
   `invalidate()` calls.
2. Inspection reads such as `getValue()` and
   `listMaterializedNodes()` are allowed to run concurrently with
   `invalidate()`.
3. `pull()` is exclusive with inspection reads.
4. `pull()` is exclusive with other `pull()` calls on the same node.
5. `pull()` calls on different nodes should not block each other.
6. Migration and replica cutover suspend all graph activity (pulls,
   invalidates, inspection reads).
7. Transaction commits for the same replica are serialized (the commit
   mutex is per-replica, not global, so commits to different replicas
   proceed concurrently).

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
`pull`/`observe` exclusion without forcing all pulls to serialize with each
other.

## Lock Keys

The implementation SHOULD derive two families of keys.

### 1. Graph activity key

There is exactly one global key:

- `GRAPH_ACTIVITY_KEY`

This key is acquired through `withModeMutex`.

Two modes are sufficient:

- `"observe"` for `invalidate()` and inspection reads;
- `"pull"` for all pull activity.

Because same-mode holders are compatible, many invalidates may overlap and many
pulls may overlap. Because different modes are incompatible, no pull may overlap
any invalidate or inspection read.

### 2. Per-node pull key

There is one exclusive key per concrete node:

- `PULL_NODE_KEY(nodeKeyString)`

This key is acquired through `withMutex`.

It is used only by pull operations, and only for the concrete node currently
being pulled. This is what serializes same-node pulls without blocking pulls on
different nodes.

## Operation Protocol

### `invalidate(node)`

1. Acquire `withModeMutex(GRAPH_ACTIVITY_KEY, "observe", ...)`.
2. Run the invalidation logic.
3. Release the mode lock.

No per-node mutex is needed.

### inspection read

1. Acquire `withModeMutex(GRAPH_ACTIVITY_KEY, "observe", ...)`.
2. Read the requested inspection data.
3. Release the mode lock.

No per-node mutex is needed.

### `pull(node)`

1. Acquire `withModeMutex(GRAPH_ACTIVITY_KEY, "pull", ...)`.
2. Acquire `withMutex(PULL_NODE_KEY(nodeKeyString), ...)` (the per-node
   mutex).
3. Open a transaction (acquires `withCommitMutex` for the active replica).
4. Pull dependencies and compute/write back the node value while holding
   the graph-activity mode lock, the per-node mutex, and the commit mutex.
5. Flush the batch and release the commit mutex.
6. Release the per-node mutex.
7. Release the graph-activity mode lock.

The commit mutex is per-replica, so commits to different replicas never
contend. Nested pulls (dependencies) reuse the same graph-activity mode
("pull") but acquire their own per-node mutex for each dependency node.
They reuse the callers's transaction (no new commit mutex acquisition).

### `migration / replica cutover`

1. Acquire `withMutex(MUTEX_KEY, ...)` (global exclusive key — serializes
   exclusive operations with each other).
2. Acquire `withModeMutex(GRAPH_ACTIVITY_KEY, "exclusive", ...)` (waits
   for all in-flight pulls, invalidates, and inspection reads to finish,
   then blocks new ones from starting).
3. Run the migration or cutover.
4. Release the exclusive mode lock.
5. Release `MUTEX_KEY`.

The two-step acquisition (`MUTEX_KEY` → `GRAPH_ACTIVITY_KEY("exclusive")`)
is deadlock-free because pull/observe operations only ever acquire
`GRAPH_ACTIVITY_KEY`.

The computor stays inside the pull critical section. This is safe because the
critical section is no longer graph-global: other pulls may still proceed on
other nodes, while invalidates and inspection reads are excluded.

## Why This Matches the Requested Semantics

### Invalidates with invalidates

Both use `GRAPH_ACTIVITY_KEY` in mode `"observe"`, so they are compatible.

### Invalidates with reads

Both use `GRAPH_ACTIVITY_KEY` in mode `"observe"`, so they are compatible.

### Pulls with reads or invalidates

Pulls use mode `"pull"` while reads and invalidates use mode `"observe"`. Those
modes conflict, so these operations are mutually exclusive.

### Pulls on the same node

They contend on the same `PULL_NODE_KEY(nodeKeyString)`, so they serialize.

### Pulls on different nodes

They share the compatible global `"pull"` mode and use different per-node mutex
keys, so they may proceed concurrently.

## Deadlock Discipline

The implementation MUST keep this acquisition discipline:

1. acquire the graph activity mode lock first;
2. acquire any per-node pull mutexes after that;
3. never acquire `"observe"` while holding a per-node pull mutex.

Inspection reads and invalidates only take the global mode lock, so they cannot
participate in a node-level cycle.

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
