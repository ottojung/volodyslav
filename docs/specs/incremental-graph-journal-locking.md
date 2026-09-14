# IncrementalGraph Journal 3 Locking and Atomic Publication

## Purpose

Journal 3 reuses the existing IncrementalGraph locking model. It does not introduce a second independent lock hierarchy.

This document specifies how journal allocation/publication fits into the existing dome/telescope/darkroom/holiday discipline from `incremental-graph-locking-design.md`.

The central rule is:

```text
journal finalization is part of graph finalization
```

A supported graph commit and the journal records which explain it cross the durable publication boundary together.

## Ordinary graph operations

Ordinary `pull()` and `invalidate()` retain their existing dome/telescope behavior.

The operation body may determine tentative replay intents outside the darkroom, but final journal identities and authority coordinates are allocated only while the per-replica darkroom serializes finalization.

The finalization boundary therefore owns both:

- reconciliation of the graph transaction against the latest committed state; and
- conversion of staged Journal 3 intents into exact immutable records.

## Why local journal allocation belongs in the darkroom

Two concurrent successful transactions under the same writer must not both allocate the same next journal sequence.

A transaction which later fails must not leave a permanent hole in the writer stream.

Therefore this pattern is forbidden:

```text
transaction starts
reserve durable A:101
transaction later fails
```

and this race is forbidden:

```text
T1 reads local head 100 -> chooses 101
T2 reads local head 100 -> chooses 101
```

Instead, darkroom finalization serializes the successful publication order:

```text
committed head = 100
T1 finalizes -> allocates 101..104 -> commits
T2 finalizes -> now observes head 104 -> allocates 105..107 -> commits
```

Failed transactions allocate no durable journal coordinates.

## Finalization sequence

For one ordinary transaction, while holding the appropriate darkroom lock:

1. read the current settled graph/journal state required for commit-time reconciliation;
2. settle validity/freshness/identifier mutations according to the existing graph transaction rules;
3. determine the **actual committed semantic transition**;
4. derive the exact Journal 3 records required by `incremental-graph-journal-emission.md`;
5. allocate one contiguous local writer sequence interval;
6. allocate semantic authority times from the current observed high-water;
7. resolve same-publication references such as a validation pointing at its newly allocated value occurrence;
8. append journal writes and materialized graph writes to one durable publication/batch;
9. flush the publication;
10. only after durable success, publish matching volatile state/caches;
11. release the darkroom.

The graph and journal must not have separate flush-success decisions.

## Computor execution remains outside the darkroom

Journal 3 does not move expensive computors into the commit mutex.

A `pull()` still executes dependency pulls and the computor under the ordinary nighttime/telescope discipline, outside the short darkroom finalization.

The transaction stages the computor's actual result as an intent. Only after that result exists does finalization assign the persistent `ValueEvent` identity and publication order.

This keeps concurrent pulls on different nodes possible while still serializing writer-log publication.

## Same-publication ValueId references

A changed computation commonly needs:

```text
ValueEvent V
ValidateEvent C where C.value == V.id
```

The transaction body does not need to know V's final sequence in advance.

It may stage a symbolic same-publication reference:

```text
newValue("K")
```

or equivalent internal handle.

During serialized finalization:

1. V receives its exact record ID;
2. the staged validation reference resolves to that ID;
3. V is ordered before C;
4. the validation basis is finalized from the then-current semantic input ValueIds and canonicalized by NodeKey;
5. both are written atomically.

These temporary handles are not persisted Journal 3 identities and must not escape the transaction.

## Commit-time propagated invalidation

Concurrent graph transactions can affect which freshness transitions actually occur.

Therefore propagated `InvalidateEvent`s must correspond to the transition after commit-time reconciliation, not blindly to a stale snapshot captured when the transaction began.

If finalization finds that a dependent was already stale before this transaction's committed effect, it does not author another propagated invalidation merely because the operation's earlier working snapshot expected a fresh-to-stale transition.

If finalization discovers an actual fresh-to-stale transition which was not known earlier, the matching Journal 3 invalidation must be added before commit.

## Journal-derived allocator caches

Implementations may keep volatile/derived caches such as:

- local journal head;
- retained frontier;
- maximum observed `AuthorityTime`;
- writer-state watermark;
- per-node current ValueId indexes.

These caches are published to volatile memory only after the same durable publication which establishes the journal/graph state they summarize.

After restart they may be reconstructed from the retained journal rather than treated as independent authority.

## Imported synchronization records

Synchronization runs under the exclusive holiday/maintenance boundary.

Source journal records may be streamed into inactive durable staging without holding the active replica darkroom for the entire transfer.

Before cutover, the synchronization operation:

1. validates the complete target journal frontier;
2. computes required receiver-authored normalization intents;
3. allocates those local records after any recovered/imported local-writer suffix;
4. constructs/validates the matching target graph projection;
5. durably flushes the target;
6. atomically switches active state.

No ordinary graph activity may overlap the final synchronization replacement/cutover.

## Same-writer suffix recovery under holiday

If synchronization/restoration imports a longer exact prefix of the receiver's own writer stream, no ordinary local authoring may race that recovery.

The holiday boundary guarantees this.

After import, local allocation caches are reconstructed from the recovered history before any synchronization normalization records are allocated. Thus a recovered local stream:

```text
A:1..120
```

is followed by new local normalization, if any, beginning at:

```text
A:121
```

never at an old pre-recovery coordinate.

## Reset and migration

Reset and migration use the holiday boundary.

They may construct a large replay baseline away from the active replica, but local record IDs/authority are allocated as one serialized writer continuation relative to the complete history observed by the operation.

Their cutover publishes:

```text
new retained journal
+ matching graph projection
+ matching writer allocator state
```

as one lifecycle transition.

## Replay rebuild

A full `rebuildProjectionFromJournal()` or equivalent maintenance operation also uses the holiday boundary.

It may discard and reconstruct derived graph/index state, but it does not mutate authoritative journal records merely to rebuild their projection.

If replay validation discovers a journal invariant violation, rebuild fails rather than silently changing history.

## Lock ordering

Journal 3 adds no lock which may be acquired before the dome and then wait for a telescope/darkroom in the opposite order.

The existing order remains:

```text
ordinary pull:
    nighttime dome
    -> telescope(s) along DAG dependency order
    -> per-replica darkroom for each transaction finalization

ordinary invalidate/read:
    daytime dome
    -> darkroom only where the existing operation requires commit-snapshot/finalization

maintenance:
    holiday gate
    -> holiday dome
    -> inactive target work / cutover
```

Journal data structures must be accessed within these existing ownership boundaries or through immutable snapshots which need no conflicting lock.

## Snapshot reads

A `JournalSnapshot` represents one exact committed frontier.

Creating such a snapshot must establish that later commits cannot change the meaning of records/frontier visible through it. This may be implemented by storage-engine snapshot primitives, immutable prefix handles, inactive replica references, or another mechanism.

Consuming a snapshot does not hold a telescope lock and does not invoke computors.

A long-lived synchronization source snapshot need not block unrelated source authoring when the existing storage/transport can provide immutable snapshot semantics; this is a performance preference, not a semantic requirement.

This document intentionally does not prescribe how Git or another transport obtains/carries that stable snapshot.

## Atomicity theorem

For every supported observable committed state C:

```text
C.graph == project(C.journal)
```

and there is no supported observation point at which a transaction has committed only one side.

This theorem applies equally to:

- ordinary pull/invalidate publication;
- synchronization cutover;
- reset cutover;
- migration cutover; and
- replay rebuild replacement.
