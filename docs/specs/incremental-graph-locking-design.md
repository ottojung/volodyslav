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
6. Lifecycle replacement workflows exclude ordinary graph activity for their
   complete maintenance interval, including inactive-replica construction and
   final cutover.
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

### `enterGarden(procedure)` and `closeGarden(procedure)`

The garden is a fair shared/exclusive lifetime lock protecting the active-replica
pointer and the lifetime of the replica to which it points.

- `enterGarden` is shared access. It selects the currently active replica and
  keeps that replica active and usable until `procedure` and every snapshot it
  consumes have finished. Multiple entrants may coexist.
- `closeGarden` is exclusive access. Once queued, it prevents later entrants
  from bypassing it, waits for every existing entrant to leave, and admits no
  new entrant until its procedure finishes.
- Replacing the active pointer and closing, deactivating, or otherwise retiring
  the previous active replica are permitted only inside `closeGarden`.
- An entrant MUST NOT copy the active pointer, leave the garden, and continue
  using the replica. Garden ownership covers the complete operation lifetime,
  including asynchronous snapshot reads performed by the procedure before it
  returns. Active-replica-backed work MUST NOT continue after the procedure
  leaves the garden.

Every outer public operation that selects and uses the active replica enters the
garden before acquiring a dome mode or any replica-local lock. An internal
schema-derived `pullNode` call is not a new public operation: it receives the
caller's active-replica context together with proof that shared garden and
nighttime dome ownership remain live, and MUST NOT re-enter the garden or
reacquire any dome mode. `possibleMaybeChanges()` needs no dome mode and follows
this complete lifetime protocol:

```text
enterGarden
    select active replica
    take fixed committed snapshot
    completely consume snapshot internally
    materialize Array<PossibleNodeChange>
leaveGarden

promise resolves with ordinary in-memory array
```

The procedure holds its garden entrance throughout active-replica selection,
snapshot creation, snapshot consumption, and array materialization. It releases
the garden before its promise resolves. The return type is
`Promise<Array<PossibleNodeChange>>`, not an async iterator. After resolution,
the caller holds only the ordinary array: retaining it, iterating it slowly, or
abandoning it cannot retain garden ownership. No database snapshot, replica
reference, iterator, or lifetime capability escapes through the return value.

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

1. Acquire `enterGarden` and select the active replica.
2. Acquire `daytimeActivity(...)` (internally `withModeMutex(DOME_ACTIVITY_KEY, "daytime", ...)`).
3. Open a transaction.
4. Run the invalidation logic inside the transaction body — this runs outside the
   darkroom lock, so concurrent invalidations can make progress.
5. Acquire the per-replica darkroom lock only for transaction finalization:
   finalize and flush any pending writes.
6. Release the darkroom.
7. Release the dome daytime lock, then leave the garden.

No per-node mutex is needed.

### inspection read

1. Acquire `enterGarden` and select the active replica.
2. Acquire `daytimeActivity(...)` (internally `withModeMutex(DOME_ACTIVITY_KEY, "daytime", ...)`).
3. Read the requested inspection data (e.g. `getValue()`, `getFreshness()`).
4. Release the dome daytime lock, then leave the garden.

No per-node mutex is needed.

`listMaterializedNodes()` additionally acquires the per-replica darkroom lock to
observe state between commit finalizations — it reads the committed identifier
lookup while no darkroom finalization is in progress.

### `pull(node)`

1. Acquire `enterGarden` and select the active replica.
2. Acquire `nighttimeActivity(...)` (internally
   `withModeMutex(DOME_ACTIVITY_KEY, "nighttime", ...)`).
3. Acquire `telescopeActivity(nodeKeyString, ...)` (internally
   `withMutex(TELESCOPE_FUNCTOR.instantiate([nodeKeyString]), ...)`).
4. Inside the telescope, open a transaction — the darkroom is NOT acquired at
   this point. The transaction body (dependency pulls and computor execution)
   runs outside the per-replica darkroom lock.
5. Run dependency pulls and the computor. Each schema-derived dependency pull
   is an internal recursive call to `pullNode` with the outer call's
   active-replica context and inherited garden/nighttime ownership. It MUST NOT
   enter the garden or acquire dome mode again. It acquires its own telescope
   mutex, creates its own transaction, commits independently under its own
   darkroom (step 6), and returns the computed value. Dependencies commit before
   the parent computor runs.
6. After the transaction body returns, acquire the per-replica darkroom lock
   **only for the short finalization phase**:
   - reconcile validity mutations against the current committed state;
   - prepare identifier-map and allocation-watermark writes;
   - flush the durable batch (LevelDB `batch` write);
   - publish the identifier overlay to the volatile committed lookup **only
     after** the disk flush succeeds.
7. In the cleanup path, release all identifier reservations owned by the
   transaction, whether the transaction committed or failed.
8. Release the per-node telescope mutex.
9. Release the dome nighttime lock, then leave the garden.

The darkroom lock is per-replica, so commits to different replicas never
contend. If a parent computor fails, successfully committed dependency pulls
remain committed — their darkroom finalizations complete before the parent
computor is invoked and before the parent transaction finalizes.

Only the outer public `pull()` acquires shared garden access and nighttime dome
mode. Schema-derived recursive `pullNode` calls inherit both ownership proofs
and the selected active replica for the entire recursive call tree; they never
re-enter the garden and never reacquire dome mode. Each `pullNode`, outer or
nested, does perform the replica-local portion of the protocol: it acquires its
own telescope mutex for the concrete node and creates its own Transaction with
its own darkroom finalization. Thus recursive calls share the lifetime/phase
prefix but have structurally identical telescope/transaction/finalization
suffixes.

### Fresh dependency-cone lemma

For supported executions in which every computor satisfies
`REQ-COMP-NOREENTER-01`, if a derived node D is up-to-date, every direct
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

Assume every computor invocation satisfies `REQ-COMP-NOREENTER-01`, so its graph
dependencies are exactly the schema-derived inputs supplied by
`IncrementalGraph` and it makes no public `IncrementalGraph` call. Let P be an
active enclosing `pull(K)` holding nighttime dome mode. If a
recursive `pull(D)` within P returns semantic value/revision d, whether by
recomputation or the up-to-date fast path, D cannot commit a different semantic
value before P releases nighttime mode. This holds transitively for every
schema-declared dependency result consumed by a parent computor.

**Proof by induction on DAG height.** Semantic changes to the active replica
occur only through graph-writing operations governed by these locks. External
invalidation is daytime and therefore cannot overlap P. A detached inactive
replica can be constructed without its own garden ownership, but construction
cannot change P's selected active replica. Supported synchronization, migration,
reset, and restoration workflows additionally hold the exclusive maintenance
boundary for their complete construction-and-cutover interval, so they cannot
overlap P; cutover itself is protected by `closeGarden` and holiday mode.
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

The bounded verifier models supported computor executions satisfying
`REQ-COMP-NOREENTER-01` and includes distinct return and telescope-release steps for
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

Constructing or validating a detached inactive replica does not intrinsically
require garden ownership: the helper performing that work neither selects nor
mutates the active replica. That fact does not grant lifecycle concurrency.
Migration, synchronization, reset, restoration, and every other supported
replacement workflow hold one exclusive maintenance interval around both
inactive construction and cutover, as required by the lifecycle specification.
The interval uses this protocol:

1. Acquire `closeGarden` and wait for all active-replica users to leave.
2. While holding the closed garden, acquire `HOLIDAY_GATE_KEY`, then acquire
   `DOME_ACTIVITY_KEY` in `holiday` mode.
3. Construct, validate, and durably flush the inactive target while ordinary
   graph activity remains excluded. Construction may use construction-only
   locks, but releases them before pointer replacement.
4. Atomically replace the active-replica pointer, then close/deactivate the
   previous active replica.
5. Release holiday dome mode, the holiday gate, and finally the closed garden.

A lower-level detached-construction helper may run concurrently in a context
that never publishes its result, but it is not a supported lifecycle replacement
workflow. Any workflow capable of cutover MUST enter the exclusive maintenance
interval before taking its source snapshot or constructing its target and MUST
NOT release that interval until cutover or abort is complete.

No active-replica pointer or old-replica lifetime transition occurs outside
step 4. Restoration of absent state follows the same publication protocol
when it installs an active replica. Journal compaction is not an independent
mutation or replacement of the active replica: it runs only while constructing
an inactive replica in one of these already-exclusive replacement workflows,
and its result becomes active only through this cutover protocol.

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

1. acquire shared `enterGarden`, or exclusive `closeGarden`, first;
2. under `closeGarden`, acquire `HOLIDAY_GATE_KEY` and then holiday dome mode;
   under `enterGarden`, acquire daytime or nighttime dome mode when applicable;
3. acquire any per-node telescope mutexes after nighttime dome mode;
4. acquire the journal allocator mutex after all applicable telescopes;
5. acquire the per-replica darkroom last.

Locks are released in reverse order. Replacement workflows acquire
`closeGarden` before construction-only locks; those construction-only locks are
released before active-pointer replacement. No code holding a dome, telescope,
allocator, or darkroom lock may request garden access, no code holding a telescope may
request another dome mode, and no allocator/darkroom path acquires a telescope.

Inspection reads and invalidates only take the global mode lock, so they cannot
participate in a node-level cycle.

Pulls may recursively pull dependencies while already holding pull locks. The
incremental graph is a DAG, so any wait edge from node `A` to node `B` implies
that `A` depends on `B`. A deadlock cycle would therefore imply a dependency
cycle, which the graph constructor already rejects.

Thus, for supported executions satisfying `REQ-COMP-NOREENTER-01`,
garden/holiday waits cannot participate in a reverse edge, replica-local
locks follow one global order, and recursive telescope waits can cycle only if
the schema dependency graph cycles. This establishes deadlock freedom for the
specified computor execution model.

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

One durable local-author allocator is serialized by the journal allocator mutex. It allocates the next immutable coordinate in the local `DatabaseFingerprint` sequence namespace. Import never allocates an event ID, changes imported identity, or advances the local counter/coverage coordinate. Foreign sequence magnitudes never influence allocation.

### Lock order

```text
garden shared entrance
  -> dome mode
  -> telescope when applicable
    -> journal allocator mutex when allocation is required
      -> darkroom commit mutex

closeGarden
  -> holiday gate
    -> holiday dome mode
      -> construction-only locks, released before cutover
      -> active-pointer replacement and old-replica retirement
```

No path reverses this order. Exclusive synchronization, migration and reset keep
their existing inactive-construction phases. The darkroom remains short: work is
prepared first and allocator values are tentatively chosen under their mutex.
The final graph, journal entries, compact reset-anchor cut summaries, `localJournalCounter`, journal coverage, and relevant causal metadata are committed
atomically under darkroom finalization. A choice published by that commit is
permanently non-reusable and committed counters never move backwards. An abort
before publication exposes neither durable allocator advancement nor a durable
coordinate, and a later transaction MAY choose that number. Allocation-number
gaps caused by allocator behavior are permitted only when committed allocator
progression skips numbers; journal compaction may leave holes among surviving entries. This does not widen the darkroom or weaken
dome/telescope serialization.

A newly authored generation and its exact `initialFreshness` target allocate in local order and commit atomically. Validation reads the transaction-visible all-mode frontier and commits a `clearsThrough` prefix justified by local closed-prefix evidence; controlled reset may additionally use the validated source snapshot under exclusive maintenance. Hardness evaluation separately reads the hard subset. A hard invalidate's `causalContext` covers the stable authority that caused it. Synchronization takes the next receiver-local coordinate and advances coverage only in the final atomic commit.

`possibleMaybeChanges()` enters the garden and takes one committed read snapshot
from the selected active replica. It retains that same garden entrance until
the fixed snapshot has been completely consumed and the result array has been
materialized, then leaves the garden before resolving its promise with that
ordinary in-memory array. It never continues reading a saved replica pointer
after leaving. It never acquires the dome, telescope, writer allocator, or
darkroom, appends an entry, changes coverage, or invokes a computor.
