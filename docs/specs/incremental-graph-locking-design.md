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
   (daytime, nighttime) and also close the garden.
7. Transaction commits for the same replica are serialized (the commit
   mutex is per-replica, not global, so commits to different replicas
   proceed concurrently).
8. Journal queries use shared garden access. Multiple journal readers
   may coexist.
9. Journal readers coexist with daytime activity, nighttime activity, and
   ordinary append-only journal growth.
10. Structural journal maintenance closes the garden, preventing new
    readers from entering.

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

### Garden domain: separate shared/exclusive lock

The garden is a separate concurrency domain, not another `withModeMutex` mode
alongside `daytime`, `nighttime`, and `holiday`. It is a shared/exclusive lock
with fairness guarantees, distinct from `withMutex` and `withModeMutex`.

Two scoped helpers are defined:

```
enterGarden(procedure)
closeGarden(procedure)
```

- `enterGarden` acquires shared garden access. Any number of `enterGarden`
  procedures may execute concurrently. It conflicts with `closeGarden`.
- `closeGarden` acquires exclusive garden access. It conflicts with all active
  and queued `enterGarden` access. It waits for existing visitors to leave and
  prevents new visitors from entering while closure is pending or active. It
  is used by compaction and every operation that structurally changes
  established journal positions.
- Fairness: once `closeGarden` is queued, later `enterGarden` calls MUST NOT
  overtake it. This prevents structural work from being starved by a continuous
  stream of readers.

### Darkroom and garden have different responsibilities

- **Darkroom** serializes durable commits to a replica.
- **Garden** stabilizes established journal structure for readers and structural
  maintenance.

Ordinary append-only journal growth (pull commits, invalidation entries) still
uses darkroom as specified. Journal queries use garden, not darkroom.

### Compatibility table

| Activity A | Activity B | May overlap? |
|---|---|---|
| `enterGarden` | `enterGarden` | yes |
| `enterGarden` | `closeGarden` | no |
| `closeGarden` | `closeGarden` | no |
| `enterGarden` | daytime activity | yes |
| `enterGarden` | nighttime activity | yes |
| `enterGarden` | ordinary journal append | yes |
| `closeGarden` | ordinary journal append | yes, except that durable commits remain serialized by darkroom |
| `closeGarden` | holiday / cutover | no, because holiday also closes the garden |

## Lock Keys

The implementation SHOULD derive three lock domains.

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

### 3. Garden access (shared/exclusive lock domain)

The garden is a separate shared/exclusive lock domain. It is NOT a
`GRAPH_ACTIVITY_KEY` mode and must not be modeled as one. See §Garden
domain for the full specification.

- Shared access: `enterGarden` — used by `possibleMaybeChanges`. Multiple
  callers may hold shared garden access concurrently.
- Exclusive access: `closeGarden` — used by compaction, structural sync,
  and migration journal mutation. Exclusive access conflicts with shared
  access (and with another exclusive holder).

The garden has no Sleeper key. It is a distinct primitive with its own
fairness guarantee: once `closeGarden` is queued, later `enterGarden`
calls MUST NOT overtake it.

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
3. Open/build the transaction without darkroom. Prepare unindexed journal entries.
4. Pull dependencies and compute the pending graph changes (values, freshness,
   journal entries) without holding the darkroom lock. The graph-activity mode
   lock and per-node mutex remain held throughout.
5. Acquire `darkroomActivity` for the active replica.
6. Allocate journal indices from the committed watermark, add the indexed
   entries and new watermark to the batch, and flush atomically.
7. Publish volatile committed state and release darkroom.
8. Release the per-node mutex.
9. Release the graph-activity mode lock.

The darkroom lock is per-replica, so commits to different replicas never
contend. Nested pulls (dependencies) reuse the same graph-activity mode
("nighttime") but acquire their own per-node mutex for each dependency node.
Each nested pull creates its own Transaction (acquiring its own darkroom
lock only during finalization) and submits its batch independently. This
matches the volatile-consistency spec: every call to pullNode is structurally
identical, whether top-level or nested.

### `possibleMaybeChanges({ since, to })`

`possibleMaybeChanges` must observe a consistent journal state through shared garden access. The published-prefix invariant guarantees that ordinary appends do not modify established positions, so the query need only exclude structural changes and read a fixed upper bound.

**Protocol:**

1. Call `enterGarden` to acquire shared garden access.
2. Select the active replica (while holding `enterGarden`).
3. Read `last_journal_index = H` from the selected replica, establishing a fixed upper bound.
4. Scan indices strictly after `since` and no greater than `H`, collecting matching `PossibleNodeChange` values into an array.
5. Leave the garden and return the array.

The linearization point is the read of `last_journal_index = H` after entering the garden. At that point:

- Structural changes are excluded by shared garden access.
- Every position at or below `H` is finalized with respect to ordinary append-only operations (see published-prefix invariant in `incremental-graph-journal-types.md`).
- Later ordinary appends receive indices greater than `H` and are outside this query.

`possibleMaybeChanges` does not acquire the `GRAPH_ACTIVITY_KEY` mode lock or the darkroom lock. Ordinary daytime and nighttime graph operations, including ordinary append-only journal growth, may overlap with journal queries.

### compaction

Compaction structurally mutates established journal positions and must close the garden.

**Protocol:**

1. Call `closeGarden` to acquire exclusive garden access.
2. Select the active replica.
3. Read `last_journal_index = H` from the selected replica, establishing a fixed bound for compaction.
4. Determine deletions only among positions `≤ H`.
5. Acquire darkroom for the atomic durable deletion batch.
6. Commit the compaction batch.
7. Release darkroom.
8. Reopen the garden.

The important requirements are:

- CloseGarden is held for the entire analysis and durable mutation, not just the final commit.
- Compaction touches only positions through its captured `H`.
- It must not modify entries appended after `H`.
- It must not decrease or overwrite a concurrently advanced `last_journal_index`.
- Ordinary append-only journal growth may continue while the garden is closed; those appends use indices greater than `H` and are outside the compacted prefix.

### `migration / replica cutover`

A holiday closes both the dome and the garden. Migration and replica cutover
follow this protocol:

1. Acquire `holidayActivity(...)` (graph activity mode lock, exclusive with
   all other graph activity).
2. Call `closeGarden` (exclusive garden access).
3. Perform the migration or cutover while both locks are held.
4. Acquire darkroom inside those scopes when performing durable replica
   mutations.
5. Release darkroom.
6. Reopen the garden.
7. Release the holiday lock.

Because `possibleMaybeChanges` holds `enterGarden` across replica selection
and traversal:

- Cutover waits for existing journal readers to leave.
- Once `closeGarden` is queued, later visitors do not overtake it.
- No new reader can select the old replica during cutover.
- The query no longer needs a separate lifecycle lock.

The two-step acquisition (`holidayActivity` → `closeGarden`) is deadlock-free
because garden is never acquired while holding darkroom, and holiday is never
acquired while holding garden.

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

`possibleMaybeChanges` uses shared garden access (`enterGarden`). It does not acquire the `GRAPH_ACTIVITY_KEY` mode lock or the darkroom lock, so it does not interfere with ordinary daytime or nighttime graph activity (reads, invalidations, pulls on different nodes, or ordinary append-only journal growth).

Journal queries coexist with daytime activity, nighttime activity, and ordinary append-only journal growth. The published-prefix invariant guarantees that ordinary appends do not modify established positions, so queries need only exclude structural changes (via garden) and read a fixed upper bound.

Structural journal maintenance (compaction, structural sync, migration journal mutation) acquires exclusive garden access (`closeGarden`). Replica cutover acquires both `holidayActivity` and `closeGarden`, preventing any new journal reader from selecting the old replica.

## Lock ordering and deadlock discipline

The implementation MUST keep this acquisition discipline:

1. When an operation needs graph activity and garden access, acquire graph
   activity first.
2. When an operation needs garden access and darkroom, acquire garden access
   first.
3. Never call `enterGarden` or `closeGarden` while holding darkroom.
4. acquire the graph activity mode lock before any per-node pull mutexes;
5. never acquire `"daytime"` while holding a per-node pull mutex.

There is no cycle because:

- Readers hold only shared garden access.
- Appenders never wait for garden.
- Structural work closes the garden before waiting for darkroom.
- Holiday acquires graph exclusion before closing the garden.
- No operation holds darkroom and then waits for garden.

Inspection reads and invalidates do not take per-node pull mutexes. Journal
queries (under `enterGarden`) also do not take per-node pull mutexes. Therefore
they cannot participate in a node-level pull-lock cycle.

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
