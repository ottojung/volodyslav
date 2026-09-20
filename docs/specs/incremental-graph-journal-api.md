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
ProjectionReader {
    get(nodeKey) -> ProjectedNodeState | absent
    iteratePresentKeys() -> AsyncIterable<NodeKey>
}

JournalSnapshot {
    databaseVersion: Version
    graphSchemeString: string
    localWriter: JournalAuthor
    frontier: JournalFrontier
    projection: ProjectionReader

    get(author, sequence) -> JournalRecord | undefined
    iterate(author, afterExclusive, throughInclusive)
        -> AsyncIterable<JournalRecord>
}
```

`ProjectedNodeState` exposes the committed observable semantic node state needed by maintenance: immutable occurrence fields, freshness, and semantic incoming validity edges. The projection reader may be backed by the existing materialized IncrementalGraph representation; it is not reconstructed by Journal replay when the snapshot is opened.

Snapshot laws:

1. version/schema, `localWriter`, frontier, records, and `projection` belong to one immutable committed source cut;
2. all remain stable for snapshot lifetime;
3. `iterate(A,p,q)` yields exactly `A:(p+1)..q` when q is inside the captured frontier;
4. ranges never silently skip coordinates;
5. semantic events have immutable same-format bodies/contexts;
6. retained history is contiguous and contexts are transitively closed;
7. `projection` exposes the committed materialized IncrementalGraph projection for that exact cut and is observationally equal to `project(records through frontier)`; this equality is a committed-state invariant, not a requirement to replay the source history when opening the snapshot;
8. reads never invoke computors or mutate state.

A generic `JournalSnapshot` says nothing about whether it is suitable for restoring a completely absent installation and safely resuming the restored local writer.

## JournalSyncSource

```text
JournalSyncSource {
    openSnapshot() -> JournalSnapshot
}
```

Synchronization/reset obtain compatibility metadata from the returned held snapshot itself. Earlier mutable metadata is insufficient.

For ordinary synchronization/reset, the receiver and held source snapshot must belong to the same supported compatibility domain. By `incremental-graph-journal-lifecycle.md` §5 and `incremental-graph-journal-theorems.md` Laws 8/8a, their shared writer prefixes are already identical and prefix-comparable. `JournalSyncSource` is not an API for proving arbitrary untrusted historical bytes fork-free by rescanning retained overlap.

If explicit validation encounters same-ID disagreement, that evidence is unsupported corruption and is reported as `JournalForkError`; ordinary change-bounded sync/reset need not search unrelated old overlap for it.

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

This absent-installation decision does not arbitrate two concurrent processes independently claiming ownership of the same installation. Concurrent live ownership of one installation/database is outside the supported lifecycle/locking model; outer installation ownership must exclude it. The cohort-bootstrap case is different because multiple legitimate legacy installations may race for one shared canonical cohort artifact, so it requires the explicit conditional-publication arbitration above.

## Reset API

```text
resetTo(source: JournalSyncSource) -> Promise<ResetResult>
```

Reset requires an established writable receiver and one held compatible snapshot.

`ResetResult.changed` is false only when the receiver already retains the complete source snapshot frontier and reset authors no semantic repair records. Importing any missing source record counts as a persistent reset change even when the projected graph is unchanged.

If that snapshot is ahead for the receiver's own writer, reset follows `incremental-graph-journal-reset.md` §Preconditions and the shared lifecycle boundary in `incremental-graph-journal-lifecycle.md` §5.

Reset may form a compatible raw receiver/source union whose selected Value/Delete heads are temporarily not dependency-closed. It inspects that staging union through `selectedHeads(J0)` and does not require full `project(J0)` before Pass 1 occurrence/presence repair. Full projection begins only after Pass 1 has restored the source target's dependency-closed selected presence.

Reset maintenance semantics include:

- one `Invalidate(scope={kind:"proof", value:V, input:D})` for every `D in eligibleEffectiveProofUnion(K) - TargetValid(K)` for a preserved occurrence V, as defined by `incremental-graph-journal-reset.md` §Pass 2; and
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

Operational semantics for `queryCanonicalBootstrap()` and `publishCanonicalBootstrapIfAbsent(...)` are specified normatively in `incremental-graph-journal-migrations.md` §4. This section defines only the interface shape and result variants.

### Canonical bootstrap operations

```text
stageCanonicalBootstrap(legacyState) -> candidate
resumeCanonicalBootstrapCreator(legacyState, artifact)
joinCanonicalBootstrap(legacyState, artifact)
```

`stageCanonicalBootstrap` is pure/deterministic over persisted legacy state: repeated staging from byte-identical legacy state produces a byte-identical candidate, including record IDs/order, contexts, AuthorityTimes, frontier, and writer-state record. Canonical creator authority allocation is defined in `incremental-graph-journal-types.md` §Canonical creator post-value authority.

Bootstrap journals the already-persisted supported legacy graph directly; it does not run ordinary semantic migration callbacks before Journal identity exists.

Creator-resume is valid only for `artifact.creatorWriter`, installs exactly the artifact, compares directly against unchanged persisted legacy semantics, and authors no duplicate history.

Join is historical merge, not reset. The exact-shared identity/proof/freshness merge and recursive stale handling are owned by `incremental-graph-journal-migrations.md` §§7.2–7.4; this API does not redefine those rules. Local-only/different legacy occurrences remain historical joining-writer evidence, and legacy absence remains non-deletion evidence as defined there.

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

The total deterministic rewrite, capability restrictions, target re-canonicalization, and global `rewriteNodeKey` injectivity contract are owned by `incremental-graph-journal-migrations.md` §9a. This API surface does not restate those codec validity rules.

Journal-aware version migration follows the canonical version chain defined in `incremental-graph-journal-migrations.md` §9b. A replica which skips application releases still executes every canonical Journal migration transition stepwise.

Semantic repair compares the codec-transported source projection and target graph in the same target NodeKey space. A non-identity representation rewrite therefore preserves a kept occurrence's ValueId rather than appearing as a delete/create pair.

The Journal-aware semantic decision API—including explicit genuine occurrence replacement—is defined normatively by `incremental-graph-journal-migrations.md` §11, with M1–M3 defining the resulting Journal repair. This API boundary does not maintain a second decision-semantics definition.

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
JournalPublicationError
JournalSourceReadError
InvalidMigrationDecisionError
```

`JournalWriterBehindError` denotes the established-writer rollback condition owned by `incremental-graph-journal-lifecycle.md` §5; operation-specific behavior is defined by the synchronization/reset specs.

## Locking ownership

Ordinary publications use the existing graph finalization/darkroom boundary. Synchronization, reset, absent restore, bootstrap/migration, and rebuild use the existing exclusive maintenance lifecycle for inactive construction/final cutover. Journal 3 adds no independent lock hierarchy.
