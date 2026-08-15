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

- `DOME_ACTIVITY_KEY` — a zero-argument term key instantiated from `makeUniqueFunctor`.

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
   finalize and flush any pending writes.
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
6. In the cleanup path, release all identifier reservations owned by the
   transaction, whether the transaction committed or failed.
7. Release the per-node telescope mutex.
8. Release the dome nighttime lock.

The darkroom lock is per-replica, so commits to different replicas never
contend. If a parent computor fails, successfully committed dependency pulls
remain committed — their darkroom finalizations complete before the parent
computor is invoked and before the parent transaction finalizes.

Nested pulls (dependencies) share the same dome nighttime activity but acquire
their own telescope mutex per concrete node and create their own Transaction
(each with its own darkroom finalization). This matches the volatile-consistency
spec: every call to pullNode is structurally identical, whether top-level or
nested.

### Fresh dependency-cone lemma

In every reachable state, if a derived node D is up-to-date, every direct
incoming validity proof required for D is present and coherent. A direct
input's semantic value change or invalidation consumes that proof and propagates
`potentially-outdated` through the validity edge before the input can later
publish another value. Applying this invariant inductively over the DAG shows
that a fresh D cannot have a transitive ancestor which is already stale in a
way capable of a later value-changing pull while D remains fresh.

The in-flight case follows from the same invariant. Consider `A -> D -> K` when
`pull(K)` reaches a fresh D. A value-changing `pull(A)` invokes A's computor only
if it observed A stale. In every reachable state that staleness has already
consumed and propagated through the complete validity edges toward fresh
transitive dependants, so D could not simultaneously take its fresh fast path.
If D was stale and its restoration overlapped A's pull, D recursively pulls A,
contends on A's telescope, and waits for A's publication before D computes and
becomes fresh. If A was fresh when the competing pull acquired its telescope,
that pull is itself a fast-path no-op. DAG induction generalizes these three
outcomes to every ancestor in D's dependency cone.

### Nighttime dependency-stability lemma

Let P be an active enclosing `pull(K)` holding nighttime dome mode. If a
recursive `pull(D)` within P returns semantic value/revision d, whether by
recomputation or the up-to-date fast path, D cannot commit a different semantic
value before P releases nighttime mode. This holds transitively for every
dependency result consumed by a parent computor.

**Proof by induction on DAG height.** Semantic changes occur only through
graph-writing operations governed by these locks. External invalidation is
daytime, while synchronization construction, migration, reset, and cutover use
incompatible daytime/holiday phases; none can overlap P's nighttime holder.
Same-node pulls serialize on the node's telescope.

For a zero-input leaf D, distinguish the two pull paths. If D was stale, its
pull computes, commits before returning, and releases D's telescope with D
fresh. A later `pull(D)` serializes after it and takes the fresh fast path. If D
was already fresh, the current pull itself takes that fast path; any later pull
also serializes and returns the same stored d. No compatible nighttime operation
can make a fresh leaf stale or change its semantic value, so D is stable in
both cases.

For the induction step, assume the theorem for every direct input of derived D:

1. **D was stale.** `pull(D)` recursively pulls every distinct direct input.
   Those same-node dependency pulls serialize through their telescopes and each
   finishes before D computes. By induction every returned input remains stable
   through P. D publishes from those stable inputs, commits before returning,
   and becomes fresh. A later same-node pull sees D and its inputs fresh and is
   a fast-path no-op.
2. **D was already fresh.** `pull(D)` returns cached d without recursively
   pulling its inputs. By the fresh dependency-cone lemma, every required direct
   validity proof is present and no stale or value-changing in-flight ancestor
   can coexist with that fresh state. Every competing ancestor pull either
   already propagated staleness so D cannot fast-return, is waited for by D's
   stale recursive path, or observes its own node fresh and changes nothing.
   Thus D's entire dependency cone and cached d remain stable through P.

The graph is a DAG, so induction reaches every transitive dependency.
Consequently every value used by K remains current through K's eventual
darkroom publication. Different-node pulls may execute concurrently; it does
not follow that already-pulled different-node semantic values may change
arbitrarily. No optimistic revision retry is needed.

The bounded verifier includes distinct return and telescope-release steps for
D, followed by reacquisition after K has consumed D but before K publishes. It
reaches this second same-node pull after both the first pull's fresh fast path
and its stale dependency-settling path, and asserts that the second invocation
can only fast-return the same semantic value consumed by K. Reachability
counters make these checks non-vacuous.

The alleged `D -> K` counterexample therefore has only this reachable trace:

```text
pull(K) holds nighttime
  pull(D) either publishes d1 from stable recursively pulled inputs,
          or fast-returns d1 from a valid fresh dependency cone
  D telescope is released
concurrent pull(D) serializes after it, sees D fresh and its cone stable,
  takes the fresh fast path, and returns d1 (not d2)
K computes from d1 and commits
```

An attempted in-flight `A -> D -> K` trace likewise cannot publish stale K:
A's pre-existing staleness has already made D stale; otherwise A's competing
pull is a fresh no-op. If D is stale, its recursive `pull(A)` waits on A's
telescope and consumes A's published result before D returns to K.

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

## Journal integration without weakening graph locking

The logical and notification allocators are distinct durable counters. One
dedicated journal allocator mutex MAY serialize both, provided their values and
semantics never influence one another. Notification replay never allocates a
logical ID or affects graph conflict ordering.

### Lock order

```text
dome mode
  -> telescope when applicable
    -> journal allocator mutex when allocation is required
      -> darkroom commit mutex

release construction locks
  -> garden close for final active-pointer switch
```

No path reverses this order. Exclusive synchronization, migration and reset keep
their existing inactive-construction phases. The darkroom remains short: work is
prepared first and allocator values are tentatively chosen under their mutex.
The final graph, logical entries, notification records, `localJournalClock`,
`localJournalRecordClock`, high-watermark, and coverage frontier are committed
atomically under darkroom finalization. A choice published by that commit is
permanently non-reusable and committed counters never move backwards. An abort
before publication exposes neither durable allocator advancement nor a durable
coordinate, and a later transaction MAY choose that number. Allocation-number
gaps caused by allocator behavior are permitted only when committed allocator
progression skips numbers; notification compaction may independently leave holes
among surviving coordinates. This does not widen the darkroom or weaken
dome/telescope serialization.

Validation reads the transaction-visible invalidate frontier and commits its
complete causal context with freshness. Hard invalidation similarly commits its
barrier after observed logical history. Notification records for those entries
commit in the same transaction. Sync raises the notification allocator above
observed high-watermarks before required replay and advances coverage only in the
final atomic commit.

`possibleMaybeChanges()` takes one committed read snapshot. It never acquires the
writer allocator, appends a record, changes a watermark/frontier, or invokes a
computor.
