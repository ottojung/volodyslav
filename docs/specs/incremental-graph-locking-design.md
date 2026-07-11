# Incremental Graph Locking Design

## Status

This document describes the locking model of the incremental graph.

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
6. Migration and replica cutover suspend all graph activity (daytime,
   nighttime, and other exclusive work).
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
`nighttime`/`daytime` exclusion without forcing all pulls to serialize with each
other.

## Lock Keys

The implementation derives keys from functor-based factories.

### 1. Dome activity key

There is exactly one dome key:

- `DOME_ACTIVITY_KEY` — a `makeUniqueFunctor` instance.

This key is acquired through `withModeMutex`. Three conditions are defined:

- `"daytime"` for `invalidate()` and inspection reads;
- `"nighttime"` for all pull activity;
- `"holiday"` for migration and replica cutover.

Because same-mode holders are compatible, many invalidates may overlap, many
pulls may overlap, and many holiday operations are serialized via the holiday
gate. Because different modes are incompatible, no pull may overlap any
invalidate, inspection read, or holiday operation.

Before acquiring the holiday dome condition, a small `HOLIDAY_GATE_KEY` mutex
serializes concurrent holiday callers with each other.

### 2. Telescope key (per-node pull)

There is one exclusive mutex per concrete node, created through the
`TELESCOPE_FUNCTOR`:

- `TELESCOPE_FUNCTOR.instantiate([nodeKeyString])`

This key is acquired through `withMutex`.

It is used only by pull operations, and only for the concrete node currently
being pulled. This is what serializes same-node pulls without blocking pulls on
different nodes.

### 3. Darkroom key (per-replica finalization)

There is one exclusive mutex per replica, created through the `DARKROOM_FUNCTOR`:

- `DARKROOM_FUNCTOR.instantiate([replicaName])`

It serializes the short finalization step where a finished transaction's batch
and identifier allocations become part of that replica's settled record.
Commit-snapshot reads (`listMaterializedNodes()`) also acquire the darkroom
to observe state between commit finalizations.

## Operation Protocol

### `invalidate(node)`

1. Acquire `daytimeActivity(...)` (internally `withModeMutex(DOME_ACTIVITY_KEY, "daytime", ...)`).
2. Open a transaction.
3. Run the invalidation logic inside the transaction body — this runs outside the
   darkroom lock, so concurrent invalidations can make progress.
4. Acquire the per-replica darkroom lock only for transaction finalization:
   flush the batch and publish identifier state.
5. Release the darkroom.
6. Release the dome daytime lock.

No per-node mutex is needed.

### inspection read

1. Acquire `daytimeActivity(...)` (internally `withModeMutex(DOME_ACTIVITY_KEY, "daytime", ...)`).
2. Read the requested inspection data (e.g. `getValue()`, `getFreshness()`).
3. Release the dome daytime lock.

No per-node mutex is needed.

`listMaterializedNodes()` additionally acquires the per-replica darkroom lock to
observe state between commit finalizations — it reads the committed identifier
lookup while no darkroom finalization is in progress.

### `pull(node)`

1. Acquire `nighttimeActivity(...)` (internally
   `withModeMutex(DOME_ACTIVITY_KEY, "nighttime", ...)`).
2. Acquire `telescopeActivity(nodeKeyString, ...)` (internally
   `withMutex(TELESCOPE_FUNCTOR.instantiate([nodeKeyString]), ...)`).
3. Inside the telescope, open a transaction — the darkroom is NOT acquired at
   this point. The transaction body (dependency pulls and computor execution)
   runs outside the per-replica darkroom lock.
4. Run dependency pulls and the computor. Each dependency pull is a recursive
   call to `pullNode` — it acquires its own telescope mutex, creates its own
   transaction, commits independently under its own darkroom (step 5), and
   returns the computed value. Dependencies commit before the parent computor
   runs.
5. After the transaction body returns, acquire the per-replica darkroom lock
   **only for the short finalization phase**:
   - reconcile validity mutations against the current committed state;
   - prepare identifier-map and allocation-watermark writes;
   - flush the durable batch (LevelDB `batch` write);
   - publish the identifier overlay to the volatile committed lookup **only
     after** the disk flush succeeds.
6. In the cleanup path, release any identifier reservations that were not
   committed.
7. Release the per-node telescope mutex.
8. Release the dome nighttime lock.

The darkroom lock is per-replica, so commits to different replicas never
contend. If a parent computor fails, successfully committed dependency pulls
remain committed — their darkroom finalizations already completed before the
parent's transaction body was entered.

Nested pulls (dependencies) share the same dome nighttime activity but acquire
their own telescope mutex per concrete node and create their own Transaction
(each with its own darkroom finalization). This matches the volatile-consistency
spec: every call to pullNode is structurally identical, whether top-level or
nested.

### `migration / replica cutover`

1. Acquire `holidayActivity(...)`.
2. Run the migration or cutover.
3. Release the holiday lock.

The two-step acquisition (`HOLIDAY_GATE_KEY` → `DOME_ACTIVITY_KEY("holiday")`)
is deadlock-free because nighttime and daytime operations only ever acquire
`DOME_ACTIVITY_KEY`.

The computor runs inside the telescope critical section but outside the
darkroom. This is safe because the critical section is no longer graph-global:
other pulls may still proceed on other nodes, while invalidates and inspection
reads are excluded.

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

They contend on the same telescope mutex key, so they serialize.

### Pulls on different nodes

They share the compatible global `"nighttime"` mode and use different per-node mutex
keys, so they may proceed concurrently.

## Deadlock Discipline

The implementation keeps this acquisition discipline:

1. acquire the dome mode lock first;
2. acquire any per-node telescope mutexes after that;
3. never acquire `"daytime"` while holding a telescope mutex.

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
