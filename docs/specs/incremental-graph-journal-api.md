# IncrementalGraph Journal 3 API

## Purpose

This document defines the software-facing semantic boundaries required by Journal 3. Names may vary in implementation, but ownership, snapshot, restore, causal, compatibility, streaming, and atomicity rules are normative.

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

A generic `JournalSnapshot` says nothing about whether it is suitable for restoring a completely absent installation and safely resuming the restored local writer.

## JournalSyncSource

```text
JournalSyncSource {
    openSnapshot() -> JournalSnapshot
}
```

Synchronization/reset obtain compatibility metadata from the returned held snapshot itself. Earlier mutable metadata is insufficient.

A generic sync source does not repair or redefine the receiver's own local-writer history.

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

If the source is ahead for the receiver's own writer, synchronization follows the failure rule in `incremental-graph-journal-sync.md` §Receiver-local writer ahead in the source is unsupported state, whose lifecycle classification is owned by `incremental-graph-journal-lifecycle.md` §5.

A fully absent installation cannot call this operation because no receiver writer identity exists yet.

## InstallationRecoverySource

`InstallationRecoverySource` is used only when the local IncrementalGraph database is completely absent and startup must decide whether to restore this installation's synchronized state or create a fresh identity:

```text
InstallationRecoverySource {
    query() ->
        Exists(ContinuationSafeSnapshot)
      | DefinitelyAbsent
      | IndeterminateOrError
}
```

This semantic interface intentionally contains no hostname, Git branch name, repository URL, filesystem path, or other transport locator. Outer transport/lifecycle code constructs the source and keeps those deployment-specific details outside IncrementalGraph persisted state and semantic APIs, per `$id-4373538486707762`.

`InstallationRecoverySource` does not imply a single server, branch, authority, or storage location. An implementation may consult one source, several sources, replicated metadata, a transport-specific publication path, or another backend protocol. Journal code only consumes the semantic answer.

`ContinuationSafeSnapshot` contains an ordinary stable Journal snapshot plus the absent-restoration guarantee defined by `incremental-graph-journal-lifecycle.md` §4.1. For its `localWriter = A` and `frontier[A] = q`, after restoring the completely absent installation no previously authored A record with sequence greater than q may later enter supported retained history.

How that guarantee is established belongs to the supported backend model. Restoration may rely on backend invariants which make some hypothetical histories impossible; it is not required to discover or defend against copies which cannot exist or later re-enter under that model. A source may return `Exists(ContinuationSafeSnapshot)` only when its backend-specific guarantees establish the property.

Records authored only on the completely lost local storage do not make q unsafe when the backend model guarantees that no surviving copy can later reintroduce them. If continuation safety cannot be established, the source returns `IndeterminateOrError`.

This source is **not** an API for repairing an existing local database that is truncated, rolled back, partially restored, or otherwise missing some of its own writer history. Those states are outside the supported lifecycle model under `$id-6158827469032147`.

The current Git-backed flow is one possible implementation of this abstraction; `incremental-graph-journal-lifecycle.md` §4.1 explains why its normal publication model can establish absent-restoration safety without storing transport locators in the database. That transport shape is not part of this API contract.

## Receiver-less absent restore

```text
restoreAbsentFrom(source: InstallationRecoverySource)
    -> Promise<RestoredDatabase>
```

Precondition: no local IncrementalGraph database/writer identity exists. An existing local database, even if damaged or older, MUST NOT be routed through this API as though it were absent.

On `Exists(S)`:

- adopt `S.localWriter`;
- restore retained history/projection;
- reconstruct local writer head, `last_node_index`, authority high-water, indexes;
- author no semantic event merely for restoration; and
- run the ordinary migration gate before exposing APIs.

`DefinitelyAbsent` permits fresh identity creation. Query/read/continuation-safety uncertainty does not.

## Reset API

```text
resetTo(source: JournalSyncSource) -> Promise<ResetResult>
```

Reset requires an established writable receiver and one held compatible snapshot.

If that snapshot is ahead for the receiver's own writer, reset follows `incremental-graph-journal-reset.md` §Preconditions and the shared lifecycle boundary in `incremental-graph-journal-lifecycle.md` §5.

Reset may form a compatible raw receiver/source union whose selected Value/Delete heads are temporarily not dependency-closed. It inspects that staging union through `selectedHeads(J0)` and does not require full `project(J0)` before Pass 1 occurrence/presence repair. Full projection begins only after Pass 1 has restored the source target's dependency-closed selected presence.

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

    publishCanonicalBootstrapIfAbsent(candidate) ->
        Published(CanonicalBootstrapSnapshot)
      | AlreadyExists(CanonicalBootstrapSnapshot)
      | IndeterminateOrError
}
```

The publication operation is the first-creator arbitration boundary required by `$id-1847369205416728`. Semantically it is conditional on the cohort's canonical slot still being absent: among concurrent distinct candidates, at most one may return `Published`. Every later/losing attempt returns `AlreadyExists(B)` with the one durable winner, or `IndeterminateOrError` when the outcome cannot be established.

`DefinitelyAbsent` from `queryCanonicalBootstrap()` is only permission to construct/stage a candidate and attempt conditional publication. It does **not** itself authorize durable canonical publication or local Journal cutover.

- `Exists(B)` -> validate target; creator-resume iff `B.creatorWriter == localFingerprint`, otherwise join;
- `DefinitelyAbsent` -> stage a deterministic candidate and call `publishCanonicalBootstrapIfAbsent(candidate)`;
- `IndeterminateOrError` -> fail and do not create.

Publication outcomes:

- `Published(B)` -> B is the durable canonical artifact; local creator cutover may proceed only after validating that B is the published form of the staged candidate;
- `AlreadyExists(B)` -> discard the losing staged candidate; creator-resume iff `B.creatorWriter == localFingerprint`, otherwise ordinary join;
- `IndeterminateOrError` -> do not cut over. The active legacy database remains unchanged; on retry/restart re-query the canonical source before deciding whether to resume, join, or retry the same conditional publication.

### Canonical bootstrap operations

```text
stageCanonicalBootstrap(legacyState) -> candidate
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

The directed source->target `JournalFormatCodec` is defined normatively in `incremental-graph-journal-migrations.md` §9a:

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

Codec functions are synchronous, deterministic, capability-free, and identity by default when omitted. As a codec-level contract, `rewriteNodeKey` is injective over every valid source semantic NodeKey which may occur in supported source-version Journal history, regardless of which keys the current replica retains. A locally observed collision is `JournalVersionCompatibilityError`, but absence of one locally is not the proof of injectivity. A codec throw or any other inability to transform every retained source record into a valid target semantic record is likewise incompatible.

Journal-aware version migration follows the canonical version chain defined in `incremental-graph-journal-migrations.md` §9b. A replica which skips application releases still executes the same Journal migration transitions semantically; a direct shortcut is valid only if it produces exactly the retained Journal the canonical chain would have produced.

Semantic repair compares the codec-transported source projection and target graph in the same target NodeKey space. A non-identity representation rewrite therefore preserves a kept occurrence's ValueId rather than appearing as a delete/create pair.

Semantic migration then:

- preserves ValueIds, freshness, and current-shape-compatible source replay proof for `keep`;
- uses node scope for true explicit `invalidate(K)`;
- uses one `proof(V,D)` barrier for every non-target edge in `eligibleEffectiveProofUnion(K)` during maintenance-only proof weakening;
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

`JournalWriterBehindError` denotes the established-writer rollback condition owned by `incremental-graph-journal-lifecycle.md` §5; operation-specific behavior is defined by the synchronization/reset specs.

## Locking ownership

Ordinary publications use the existing graph finalization/darkroom boundary. Synchronization, reset, absent restore, bootstrap/migration, and rebuild use the existing exclusive maintenance lifecycle for inactive construction/final cutover. Journal 3 adds no independent lock hierarchy.
