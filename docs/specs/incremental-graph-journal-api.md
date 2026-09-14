# IncrementalGraph Journal 3 API

## Purpose

This document defines the software-facing boundaries required by Journal 3.

Journal 3 deliberately does not expose raw journal mutation to ordinary computors or application code. The public IncrementalGraph contract remains centered on `pull()`, `invalidate()`, and inspection. Journal storage/replay APIs are internal infrastructure used by graph transactions, synchronization, migration, reset, recovery, and diagnostics.

The API shapes below are semantic interfaces. Exact JavaScript class/function names may differ, but an implementation must preserve the ownership, snapshot, streaming, atomicity, and error behavior specified here.

They do not prescribe or replace a Git/remote/backend protocol. An existing transport may adapt its stable snapshot into these semantic interfaces without Journal 3 specifying how that transport discovers, stores, or publishes the bytes.

## Public IncrementalGraph behavior

Journal 3 does not add a new way for ordinary callers to mutate graph state.

Existing operations keep their existing user-visible meaning:

```text
pull(nodeName, bindings?)
invalidate(nodeName, bindings?)
inspection reads
```

Journal 3 changes persistence underneath those operations:

- a successful state-changing operation appends replay-complete journal records atomically with its materialized graph changes;
- a read-only/fresh fast-path operation appends no semantic event merely because it was called;
- callers do not provide event IDs, HLC values, causal contexts, ValueIds, or journal sequence numbers;
- callers do not choose whether an event should be emitted. Event emission is determined by the graph transition.

Synchronization, reset, and migration remain administrative/lifecycle operations rather than computor-visible graph operations.

## No public raw-journal mutation API

The following must not be exposed as ordinary application APIs:

```text
appendArbitraryJournalRecord(...)
setJournalFrontier(...)
replaceWriterStream(...)
setValueId(...)
setAuthorityTime(...)
```

Raw imported records cross a validated synchronization boundary; locally authored records cross a validated journal-transaction boundary. Arbitrary callers cannot manufacture either representation.

A future read-only journal-inspection API may expose history for diagnostics. Such an API must not permit mutation and is outside the core Journal 3 contract.

## JournalStore

Conceptually, each live database owns one `JournalStore` associated with the same durable transaction domain as the materialized IncrementalGraph state.

It provides these capabilities:

```text
JournalStore {
    localWriter(): JournalAuthor
    snapshot(): JournalSnapshot
    beginLocalPublication(): JournalPublication
    beginImportTarget(): JournalImportTarget
}
```

The store is not independently swappable from the graph database. A committed supported database always pairs one retained journal with its matching projection.

## JournalSnapshot

A `JournalSnapshot` is an immutable read view at one exact committed journal frontier:

```text
JournalSnapshot {
    localWriter: JournalAuthor
    frontier: JournalFrontier

    get(author, sequence) -> JournalRecord | undefined

    iterate(
        author,
        afterExclusive,
        throughInclusive
    ) -> AsyncIterable<JournalRecord>
}
```

Snapshot laws:

1. `frontier` never changes during the snapshot lifetime.
2. `iterate(A,p,q)` yields exactly `A:(p+1)..q` in ascending sequence order when `q <= frontier[A]`.
3. It never silently skips a sequence.
4. Every yielded record is the immutable record stored under that `JournalRecordId`.
5. The snapshot exposes a causally closed retained journal.
6. Reading a snapshot never invokes computors and never mutates journal or graph state.

An implementation may additionally provide efficient node/event indexes, but callers must not infer authority from an index that is not part of the immutable record history.

## Stable synchronization source

Synchronization consumes a stable source abstraction rather than transport-specific concepts:

```text
JournalSyncSource {
    openSnapshot() -> JournalSnapshot
}
```

The returned snapshot stays stable until released by the synchronization caller. How Git, another local database, a file, or another transport provides that snapshot is outside Journal 3 semantics.

A synchronization algorithm may issue many range reads against the snapshot. All of those reads belong to the same frozen source frontier.

This is the only source-read stability property synchronization requires semantically: one operation must not accidentally read writer heads from one source state and records from a later incompatible source state.

## JournalPublication

Ordinary local graph operations do not allocate final journal identities speculatively while their transaction may still fail or race another commit.

Instead they build replay-relevant **publication intents** during the transaction body and finalize those intents inside the same serialized per-replica commit boundary that publishes graph state.

Conceptually:

```text
JournalPublication {
    stageValue(...)
    stageValidation(...)
    stageInvalidation(...)
    stageDelete(...)
    stageWriterState(...)

    finalizeWithGraphTransition(finalTransition)
        -> FinalizedJournalRecords
}
```

The stage methods do not expose committed `JournalRecordId`s.

At finalization, while the local writer commit frontier is serialized, the implementation:

1. reads the current committed local writer head;
2. reads/recomputes the current authority high-water mark;
3. determines the actual finalized graph transition after commit-time reconciliation;
4. removes staged effects which did not actually occur;
5. creates any additional replay records required by the finalized transition, including propagated stale transitions discovered only at commit time;
6. constructs each ordinary validation basis from the finalized current direct-input NodeKeys/ValueIds and canonicalizes entries by NodeKey;
7. allocates one contiguous block of writer-local sequence numbers;
8. assigns exact `JournalRecordId`s, `ValueId`s, causal contexts, and `AuthorityTime`s in the required deterministic topological order;
9. resolves same-publication references such as a `ValidateEvent` naming a newly allocated `ValueEvent`;
10. adds the finalized journal writes to the same durable graph batch/publication;
11. commits journal and graph atomically.

If finalization fails, none of the staged intents become durable journal history.

## Why IDs are allocated at finalization

A supported writer stream has no holes and cannot reuse an ID.

Therefore a transaction must not permanently reserve `A:q` merely when it begins, because the transaction may fail while another transaction commits. Nor may two concurrent transactions both derive `q+1` from an old head.

Serialized finalization gives the simple law:

```text
committed local stream before = A:1..q
next successful publication   = A:q+1..r
committed local stream after  = A:1..r
```

Failed operations consume no durable journal positions.

This differs from `last_node_index`, whose allocation watermark may intentionally contain gaps. Journal sequence positions may not.

## Commit-time transition is authoritative for emission

Event emission describes what actually becomes committed, not what an optimistic transaction body initially expected.

This matters for concurrent operations such as validity mutation reconciliation. If a transaction staged an invalidation of a node which is already stale by finalization time, it must not author a duplicate propagated-staleness record merely because an earlier snapshot suggested a transition would occur.

Similarly, a propagated invalidation record is required when finalization determines that a current value actually transitions from fresh to stale, even if that fact was discovered during commit-time reconciliation rather than the earlier transaction body.

The invariant is always:

```text
project(committedJournalAfter)
    == committedGraphAfter
```

## JournalImportTarget

Synchronization imports immutable records authored by arbitrary retained writers. Import is different from local authoring:

```text
JournalImportTarget {
    stageImportedRecord(record)
    stageLocalNormalizationIntent(...)
    validate()
    commitWithProjection()
}
```

Imported records preserve their exact IDs and canonical meanings. The import path must reject:

- a hole in a claimed writer prefix;
- conflicting content for an already-retained ID;
- malformed/unsupported record encoding;
- impossible ValueId reference causality;
- duplicate/noncanonical self-describing validation-basis entries;
- a final frontier which is not causally closed;
- a final replay/projection which violates Journal 3 or IncrementalGraph invariants.

A historical validation record is not invalid merely because its explicit input-key set differs from the current schema. It remains retained history; replay simply does not use it as current-shape-compatible proof.

The target may be durable scratch/inactive storage and may be populated incrementally. It becomes active only through one atomic cutover which installs both retained journal state and its matching graph projection.

Synchronization-created local normalization records are finalized through the receiver writer's ordinary contiguous allocation and HLC rules before that cutover.

## Replay API

Conceptually Journal 3 requires:

```text
projectJournal(snapshot, localWriter, graphSchema)
    -> ProjectedIncrementalGraphState
```

The normative result is defined by `incremental-graph-journal-replay.md`.

Implementations are not required to call a literal whole-history function in production. They may maintain an incrementally updated projection, node indexes, or replay checkpoints.

However, the implementation must provide an internal validation/rebuild path capable of establishing equivalence to full replay. A useful conceptual maintenance operation is:

```text
rebuildProjectionFromJournal()
```

which discards derived graph/index state and reconstructs it from authoritative retained history under the current compatible interpretation.

This operation is administrative and exclusive with ordinary graph activity.

## Synchronization API semantics

The semantic pairwise operation is:

```text
synchronizeFrom(source: JournalSyncSource) -> Promise<SyncResult>
```

with:

```text
SyncResult = {
    imported: JournalFrontierDelta,
    authoredThrough: JournalSequence,
    changed: boolean
}
```

Exact return-object spelling is implementation-defined; these meanings are normative:

- `imported` describes immutable records newly retained from the source snapshot;
- `authoredThrough` is the receiver's local writer head after any synchronization normalization records;
- `changed` is true iff the committed journal/projection changed.

A successful call means the receiver has atomically committed a valid causally closed union/normalization result.

A source which contributes no missing records and requires no normalization is a semantic no-op.

Synchronization-authored normalization is real journal history. The API does not promise to retract it if later unseen concurrent history changes current graph selection.

For an outer operation synchronizing multiple sources, each `synchronizeFrom` may be its own atomic commit. Therefore an aggregate multi-source failure may coexist with earlier successful source synchronizations unless the outer lifecycle explicitly provides a stronger all-sources transaction.

## Synchronization errors

Implementations should expose specific error classes/values for at least these categories:

```text
JournalForkError
JournalGapError
JournalCausalClosureError
JournalReferenceCausalityError
JournalRecordValidationError
JournalVersionCompatibilityError
JournalProjectionError
JournalPublicationError
```

The names are illustrative; the distinctions are normative.

A caller must be able to distinguish:

- incompatible/unsupported input which must not be merged;
- conflicting same-writer history;
- malformed/corrupt journal records;
- projection invariant failure;
- ordinary I/O/publication failure.

Payload equality, transport ancestry, or arbitrary source preference must not turn a fork/corruption error into a successful merge.

## Reset API semantics

The semantic reset operation is:

```text
resetTo(source: JournalSyncSource) -> Promise<ResetResult>
```

It is an exclusive lifecycle operation specified by `incremental-graph-journal-reset.md`.

A successful reset preserves retained history and appends a causally-later local reset baseline so that the receiver's materialized graph becomes observationally equivalent to the chosen source projection under the reset rules.

Reset does not destructively replace the receiver's journal with the source journal.

## Migration/bootstrap API boundary

Journal bootstrap and version migration remain owned by the database migration lifecycle. Migration code does not receive an unrestricted raw journal writer.

Instead the Journal-3-aware migration layer translates the migration's settled target state into the baseline/history records required by `incremental-graph-journal-migrations.md` and commits them atomically with migration cutover.

## Locking ownership

Ordinary publications use the existing graph transaction/darkroom finalization boundary.

Synchronization, reset, replay rebuild, and migration require the existing exclusive maintenance (`holiday`) boundary because they may replace/rebuild a large portion of the active projection or cut over an inactive target.

The journal layer must not introduce an independent lock order which can invert the existing dome/telescope/darkroom discipline. Detailed integration is specified by `incremental-graph-locking-design.md`.
