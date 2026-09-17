# IncrementalGraph Journal 3 API

## Purpose

This document defines the software-facing semantic boundaries required by Journal 3. Names may vary in implementation, but ownership, snapshot, recovery, causal, compatibility, streaming, and atomicity rules are normative.

This API does not define or replace a Git/backend protocol.

## Ordinary graph APIs

Application code continues to use ordinary `pull()`, `invalidate()`, and inspection APIs. Callers never supply Journal IDs, ValueIds, contexts, authority times, or writer identities.

No public arbitrary-Journal mutation API is supported.

## JournalStore

```text
JournalStore {
    localWriter(): JournalAuthor
    snapshot(): JournalSnapshot
    beginLocalPublication(): JournalPublication
    beginImportTarget(): JournalImportTarget
}
```

A committed database pairs one retained Journal with its matching projection and compatibility metadata in one durable state.

## JournalSnapshot

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

Snapshot laws:

1. version/schema, `localWriter`, frontier, and records belong to one immutable committed source cut;
2. all remain stable for snapshot lifetime;
3. `iterate(A,p,q)` yields exactly `A:(p+1)..q` when q is inside the captured frontier;
4. ranges never silently skip coordinates;
5. semantic events have immutable same-format bodies/contexts;
6. retained history is contiguous and contexts are transitively closed;
7. reads never invoke computors or mutate state.

A generic `JournalSnapshot` says nothing about whether its `localWriter` head is safe to **resume authoring that writer after local history loss**.

## JournalSyncSource

```text
JournalSyncSource {
    openSnapshot() -> JournalSnapshot
}
```

Synchronization/reset obtain compatibility metadata from the returned held snapshot itself. Earlier mutable metadata is insufficient.

A generic sync source is not continuation authority for the receiver's own writer.

## JournalPublication

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

Serialized finalization:

1. reads latest committed local writer head/authority high-water;
2. reconciles against the actual final graph transition;
3. drops staged effects that did not occur and adds required commit-time effects;
4. finalizes validation bases from final current input ValueIds;
5. allocates one contiguous local sequence block;
6. assigns IDs in deterministic semantic dependency order;
7. gives every semantic `(W,q)` own-writer context `q-1`;
8. starts cross-writer context from the complete causally closed frontier semantically observed;
9. resolves same-publication references only to earlier records;
10. allocates authority extending every causal predecessor; and
11. atomically writes Journal + matching graph transition.

Failed operations consume no durable Journal coordinate.

## Context construction

A context is semantic history, not merely direct references. If a publication observes B:7 and B:7 observed A:11, its context contains A through at least 11.

The only controlled exception is pre-Journal historical ValueEvent conversion described by the bootstrap spec; migration execution read order does not invent causality between pre-existing legacy values.

## JournalImportTarget

```text
JournalImportTarget {
    stageImportedRecord(record)
    stageLocalNormalizationIntent(...)
    validate()
    commitWithProjection()
}
```

Import rejects gaps, same-ID disagreement, invalid current-format records, open/non-transitive contexts, wrong own-writer prefix, authority violations, impossible references, malformed bases/scopes, and projection failures. Imported records are never rewritten locally to repair these defects.

## Replay API

```text
projectJournal(snapshot, localWriter, graphSchema)
    -> ProjectedIncrementalGraphState
```

Optimized replay/index/checkpoint implementations must remain observationally equivalent to the normative full replay model.

## Pairwise synchronization API

```text
synchronizeFrom(source: JournalSyncSource) -> Promise<SyncResult>
```

Success means source compatibility came from the held snapshot, imported records were retained unchanged, normalization was complete, and active graph equals Journal replay.

If the source exposes a longer prefix of the receiver's **own** writer, this operation does not recover that writer. It fails with `JournalWriterBehindError` before receiver-authored normalization/cutover and requires authoritative recovery first.

A fully absent installation cannot call this operation because no receiver writer identity exists yet.

## InstallationRecoverySource

Writer continuation after local absence/rollback uses a stronger source:

```text
InstallationRecoverySource {
    query() ->
        Exists(ContinuationSafeSnapshot)
      | DefinitelyAbsent
      | IndeterminateOrError
}
```

`ContinuationSafeSnapshot` contains an ordinary stable Journal snapshot plus the semantic guarantee defined by `database-lifecycle.md` §4.1. For its `localWriter = A` and `frontier[A] = q`, the source guarantees that after recovery no previously authored A record with sequence greater than q can later enter supported retained history for writer A.

That is a guarantee about future admissible history, not every local record ever committed. Records lost only with the old local storage and unable to re-enter supported history do not make q unsafe. If a higher A record can still re-enter supported history, q is not continuation-safe.

A source which cannot establish that guarantee MUST return `IndeterminateOrError`. A merely readable/lagging peer copy is insufficient.

The guarantee is transport-neutral: Journal 3 does not prescribe how a transport/storage layer establishes continuation authority. It does not require contacting or discovering every possible peer.

## Receiver-less absent restore

```text
restoreAbsentFrom(source: InstallationRecoverySource)
    -> Promise<RestoredDatabase>
```

On `Exists(S)`:

- adopt `S.localWriter`;
- restore retained history/projection;
- reconstruct local writer head, `last_node_index`, authority high-water, indexes;
- author no semantic event merely for restoration; and
- run the ordinary migration gate before exposing APIs.

`DefinitelyAbsent` permits fresh identity creation. Query/read/continuation-safety uncertainty does not.

## Existing-writer authoritative recovery

```text
recoverExistingWriterFrom(source: InstallationRecoverySource)
    -> Promise<RecoveredDatabase>
```

Preconditions:

- local database already has writer A;
- source returns `Exists(S)` with `S.localWriter == A` and a continuation-safe A head;
- local A prefix is an exact prefix of S's A stream;
- any imported foreign history required by retained event contexts is available.

Recovery:

1. imports missing A suffix and required causal history;
2. rejects divergent overlap as `JournalForkError`;
3. reconstructs A head, allocator watermark, authority high-water, projection/indexes;
4. atomically publishes the recovered state; and
5. only then permits another A-authored record, strictly after the continuation-safe recovered head.

If continuation safety cannot be established, recovery fails; Journal 3 does not guess a sequence or silently roll over writer identity.

## Reset API

```text
resetTo(source: JournalSyncSource) -> Promise<ResetResult>
```

Reset requires an established writable receiver and one held compatible snapshot.

If that snapshot reveals a longer receiver-local writer prefix, reset fails `JournalWriterBehindError` before importing records or authoring events. A `JournalSyncSource` cannot authorize continuation; lifecycle must complete `recoverExistingWriterFrom(InstallationRecoverySource)` first, then retry reset.

Reset maintenance semantics include:

- one `Invalidate(scope={kind:"proof", value:V, input:D})` for every currently-valid incoming edge D intentionally removed while preserving V; and
- a `value(V)` stale marker when target freshness is persistently stale while V's own **effective** proof is complete.

Proof-edge barriers retire only the named `(V,D)` edge. Concurrent barriers compose by subtracting the union of named edges; another ValueId is unaffected.

## Bootstrap API boundary

### CanonicalBootstrapSnapshot

```text
CanonicalBootstrapSnapshot {
    databaseVersion: Version
    graphSchemeString: string
    creatorWriter: JournalAuthor
    bootstrapFrontier: JournalFrontier

    get(author, sequence) -> JournalRecord | undefined
    iterate(author, afterExclusive, throughInclusive)
        -> AsyncIterable<JournalRecord>
}
```

It exposes exactly the immutable original bootstrap cut, not later current Journal history. It is supported only when its version/schema exactly match the running release's configured bootstrap target.

### CohortBootstrapSource

```text
CohortBootstrapSource {
    queryCanonicalBootstrap() ->
        Exists(CanonicalBootstrapSnapshot)
      | DefinitelyAbsent
      | IndeterminateOrError
}
```

- `Exists(B)` -> validate target; creator-resume iff `B.creatorWriter == localFingerprint`, otherwise join;
- `DefinitelyAbsent` -> canonical creation is allowed only under the source's first-creator arbitration contract;
- `IndeterminateOrError` -> fail and do not create.

### Canonical bootstrap operations

```text
createCanonicalBootstrap(legacyState)
resumeCanonicalBootstrapCreator(legacyState, artifact)
joinCanonicalBootstrap(legacyState, artifact)
```

Bootstrap journals the already-persisted supported legacy graph directly; it does not run ordinary semantic migration callbacks before Journal identity exists.

Creator-resume is valid only for `artifact.creatorWriter`, installs exactly the artifact, compares directly against unchanged persisted legacy semantics, and authors no duplicate history.

Join is historical merge, not reset. It:

- reuses canonical ValueIds for exact shared occurrences;
- converts local-only/different legacy occurrences as historical concurrent bootstrap values using legacy `modifiedAt` authority;
- records locally-authored proof against the joining host's own legacy input occurrence ValueIds, not whichever input occurrences later win conflict selection;
- treats legacy absence as no deletion evidence;
- intersects exact-shared positive validity: canonical proof is the basis and `proof(V,D)` barriers remove canonical edges the joining side lacks;
- never adds joining-only proof to an exact shared occurrence;
- preserves exact-shared stale state if either side is stale; and
- persists recursive-only stale dependents after direct proof/stale roots are represented.

## Journal-aware migration API boundary

The directed source->target `JournalFormatCodec` is defined normatively in `migration.md` §Journal format codec:

```text
JournalFormatCodec {
    rewriteNodeKey(sourceKey: NodeKey) -> NodeKey
    rewriteComputedValue(
        sourceKey: NodeKey,
        payload: ComputedValue
    ) -> ComputedValue
}

rewriteJournalFormat(
    source: JournalSnapshot,
    sourceVersion: Version,
    targetVersion: Version,
    codec: JournalFormatCodec
) -> TargetFormatJournal
```

The format rewrite is deterministic over the **entire retained source-format record domain**, including historical records for node families absent from target schema. It decodes source records, rewrites embedded NodeKeys and retained ValueEvent payloads, re-canonicalizes target structures such as ValidationBasis order, preserves record IDs/historical meaning/references, and encodes the target format.

Codec functions are synchronous, deterministic, capability-free, and identity by default when omitted. A codec throw or any other inability to transform every retained source record into a valid target semantic record is `JournalVersionCompatibilityError` before cutover.

Semantic migration then:

- preserves ValueIds, freshness, and current-shape-compatible source replay proof for `keep`;
- uses node scope for true explicit `invalidate(K)`;
- uses one `proof(V,D)` barrier per removed incoming validity edge for maintenance-only proof weakening;
- persists target propagated stale state with `value(V)` when own effective proof is otherwise complete; and
- creates new ValueEvents only for genuine new/replaced occurrences.

Independent genuine replacement migrations may create distinct replacement ValueIds; later synchronization handles the normal conflict/staleness consequence.

## Error categories

Lifecycle/admin code distinguishes at least:

```text
JournalForkError
JournalBootstrapForkError
JournalGapError
JournalCausalClosureError
JournalReferenceCausalityError
JournalRecordValidationError
JournalVersionCompatibilityError
JournalWriterBehindError
JournalProjectionError
JournalProjectionMismatchError
JournalPublicationError
JournalSourceReadError
InvalidMigrationDecisionError
```

## Locking ownership

Ordinary publications use the existing graph finalization/darkroom boundary. Synchronization, reset, recovery, restore, bootstrap/migration, and rebuild use the existing exclusive maintenance lifecycle for inactive construction/final cutover. Journal 3 adds no independent lock hierarchy.
