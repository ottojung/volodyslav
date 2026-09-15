# IncrementalGraph Journal 3 API

## Purpose

This document defines the software-facing boundaries required by Journal 3.

The shapes are semantic interfaces rather than prescribed JavaScript names. Implementations may vary while preserving the ownership, snapshot, causal-context, streaming, atomicity, compatibility, and error behavior below.

This API does not define or replace a Git/backend protocol.

## Ordinary graph APIs remain ordinary graph APIs

Application code continues to use `pull()`, `invalidate()`, and inspection APIs.

Ordinary callers never supply:

- Journal IDs/sequences;
- causal contexts;
- authority times;
- ValueIds;
- writer identities.

Journal emission is derived from the committed graph transition.

No ordinary raw-journal mutation API such as `appendArbitraryJournalRecord()` or `setJournalFrontier()` is supported.

## JournalStore

Each established live database owns one JournalStore in the same durable transaction domain as its materialized graph/global metadata:

```text
JournalStore {
    localWriter(): JournalAuthor
    snapshot(): JournalSnapshot
    beginLocalPublication(): JournalPublication
    beginImportTarget(): JournalImportTarget
}
```

A supported committed database always pairs one retained journal with its matching projection and compatibility metadata.

## JournalSnapshot compatibility metadata

A snapshot includes the existing durable interpretation metadata:

```text
JournalSnapshot {
    databaseVersion: Version
    graphSchemeString: string
    localWriter: JournalAuthor
    frontier: JournalFrontier

    get(author, sequence) -> JournalRecord | undefined
    iterate(author, afterExclusive, throughInclusive)
        -> AsyncIterable<JournalRecord>
}
```

`databaseVersion` is the exact persisted `global/version`.

`graphSchemeString` is the exact persisted `global/graph_scheme` string. Textually distinct strings are distinct even if they parse to equivalent JSON under some external comparison.

Snapshot laws:

1. compatibility metadata, `localWriter`, frontier, and records belong to one immutable committed selected-replica state;
2. all remain stable for the snapshot lifetime;
3. `iterate(A,p,q)` yields exactly `A:(p+1)..q` when q is within the captured frontier;
4. ranges never silently skip coordinates;
5. exposed semantic events have already-defined immutable bodies/contexts;
6. the captured retained history is contiguous and every semantic-event context is a transitively causally closed cut;
7. snapshot reads never invoke computors or mutate graph/journal state.

A transport adapter may implement this abstraction using its existing mechanisms. Journal 3 does not prescribe those mechanisms.

## JournalSyncSource

Conceptually:

```text
JournalSyncSource {
    openSnapshot() -> JournalSnapshot
}
```

Synchronization/reset obtains compatibility metadata **from the returned held snapshot itself**. An earlier mutable metadata query is not sufficient.

## JournalPublication

Ordinary graph operations stage semantic intents before commit but do not reserve durable Journal coordinates early.

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

During serialized finalization the implementation:

1. reads the latest committed local writer head and authority high-water;
2. reconciles against the actual final graph transition;
3. removes staged effects which did not occur and adds required commit-time effects;
4. finalizes validation bases from final current input ValueIds;
5. allocates one contiguous writer sequence block;
6. assigns exact event IDs/ValueIds in deterministic topological order;
7. assigns every semantic event `(W,q)` an own-writer context coordinate exactly `q-1`;
8. starts its cross-writer context from the complete causally closed frontier the publication observed, thereby preserving transitive closure;
9. resolves same-publication references only to earlier records;
10. allocates AuthorityTimes which extend every causal predecessor;
11. writes finalized Journal records and matching graph mutations atomically.

Failed operations consume no durable Journal coordinate.

## Context construction is not optional metadata

A persisted event context is semantic history. It must never be populated as merely “writers explicitly referenced by this event.”

If the publication observed event B:7 and B:7 observed A:11, the new event context must include A through at least 11 even if the new event directly references only B.

This is what makes `happenedBefore` transitive and makes invalidation coverage trustworthy.

## JournalImportTarget

Synchronization imports foreign immutable records rather than re-authoring them:

```text
JournalImportTarget {
    stageImportedRecord(record)
    stageLocalNormalizationIntent(...)
    validate()
    commitWithProjection()
}
```

Import validation rejects at least:

- writer-prefix gaps;
- same-ID body disagreement;
- bytes invalid under the current database version;
- event contexts whose coordinates are missing;
- event contexts whose own-writer coordinate is not sequence minus one;
- event contexts which include an event but omit that event's causal predecessors;
- happened-before edges not extended by authority;
- impossible ValueId references;
- malformed/noncanonical validation bases;
- projection/invariant failure.

An imported record is never rewritten locally to repair any of those conditions.

Staging may be incomplete while transfer is underway, but unsupported partial history is never activated.

## Replay API

Conceptually:

```text
projectJournal(snapshot, localWriter, graphSchema)
    -> ProjectedIncrementalGraphState
```

Production may use indexes/incremental folding/checkpoints, but an internal validation/rebuild path must remain equivalent to full normative replay.

A conceptual maintenance operation is:

```text
rebuildProjectionFromJournal()
```

which may rebuild derived graph/index state but not authoritative history.

## Pairwise synchronization API

Conceptually:

```text
synchronizeFrom(source: JournalSyncSource) -> Promise<SyncResult>
```

with meanings such as:

```text
SyncResult = {
    imported: JournalFrontierDelta,
    authoredThrough: JournalSequence,
    changed: boolean
}
```

Success means:

- source compatibility was checked from the held snapshot;
- source records were retained unchanged;
- all imported/local semantic-event contexts are valid closed cuts;
- required receiver normalization is included;
- active graph equals replay of active Journal.

A fully absent installation cannot call this operation because no receiver writer identity exists yet.

## Receiver-less absent-state restore API

The lifecycle needs a separate conceptual operation:

```text
restoreAbsentFrom(source: InstallationRecoverySource)
    -> Promise<RestoredDatabase>
```

where `InstallationRecoverySource` is the configured transport-neutral source for **this installation's own synchronized state**.

The operation:

1. opens one held source snapshot;
2. adopts `snapshot.localWriter` as the continuing local `DatabaseFingerprint`/writer;
3. restores retained history/projection/allocator state for that installation;
4. creates no new semantic history merely for restoration;
5. hands the restored database to the normal migration gate before graph APIs are exposed.

If querying/opening known synchronized installation state fails, startup fails. This API must not silently return “fresh database.”

Fresh creation is a separate lifecycle result used only when the recovery source definitively reports absence.

The source-discovery mechanism itself is outside Journal semantics.

## Reset API

Conceptually:

```text
resetTo(source: JournalSyncSource) -> Promise<ResetResult>
```

Reset requires an already-established writable receiver.

It uses one held compatible source snapshot and the minimal deterministic rules in `incremental-graph-journal-reset.md`:

- preserve a selected current ValueId when the union already selects the requested immutable value occurrence;
- create a ValueEvent only when the target value occurrence must actually change;
- use ValidateEvent/InvalidateEvent for proof/freshness changes;
- author DeleteEvent exactly when a currently selected value must become target absence;
- repeated already-satisfied reset may no-op.

Reset retains old history; it never replaces the receiver Journal wholesale.

## Bootstrap/migration API boundary

Bootstrap/migration remains owned by the database lifecycle rather than an unrestricted journal writer API.

Pre-Journal bootstrap has two semantic roles:

```text
createCanonicalBootstrap(legacyState)
joinCanonicalBootstrap(legacyState, canonicalSnapshot)
```

The first authors one canonical semantic bootstrap history for a reconciled synchronization cohort. The second verifies legacy graph equivalence, retains those exact semantic records, preserves the joining installation's own local writer/allocator state, and does not mint duplicate ValueIds.

Journal-aware migration separates:

```text
rewriteJournalFormat(...)
computeMigrationTarget(...)
applyRequiredSemanticMigration(...)
```

The semantic phase preserves existing ValueIds for preserved occurrences and appends only the value/delete/proof/freshness events actually needed for the target state.

When migration genuinely creates/replaces occurrences, the cohort uses one canonical semantic migration history as defined by the migration specification; peers do not independently mint equivalent new ValueIds.

These are lifecycle semantics, not a remote protocol definition.

## Error categories

Lifecycle/admin callers must be able to distinguish at least:

```text
JournalForkError
JournalGapError
JournalCausalClosureError
JournalReferenceCausalityError
JournalRecordValidationError
JournalVersionCompatibilityError
JournalProjectionError
JournalPublicationError
JournalSourceReadError
```

The exact class names may differ; the semantic distinctions are normative.

## Locking ownership

Ordinary publications use the existing graph finalization/darkroom boundary.

Synchronization, reset, migration/bootstrap, absent restore, and projection rebuild use the existing exclusive maintenance lifecycle where they build/cut over large target state.

Journal 3 adds no independent lock hierarchy.