# IncrementalGraph Journal 3 API

## Purpose

This document defines the software-facing boundaries required by Journal 3.

The shapes are semantic interfaces rather than prescribed JavaScript names. Implementations may vary while preserving the ownership, snapshot, causal-context, streaming, atomicity, compatibility, and error behavior below.

This API does not define or replace a Git/backend protocol.

## Ordinary graph APIs remain ordinary graph APIs

Application code continues to use `pull()`, `invalidate()`, and inspection APIs.

Ordinary callers never supply Journal IDs/sequences, causal contexts, authority times, ValueIds, or writer identities. Journal emission is derived from the committed graph transition.

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

`databaseVersion` is the exact persisted `global/version`. `graphSchemeString` is the exact persisted `global/graph_scheme` string.

Snapshot laws:

1. compatibility metadata, `localWriter`, frontier, and records belong to one immutable committed selected-replica state;
2. all remain stable for the snapshot lifetime;
3. `iterate(A,p,q)` yields exactly `A:(p+1)..q` when q is within the captured frontier;
4. ranges never silently skip coordinates;
5. exposed semantic events have immutable same-version bodies/contexts;
6. retained history is contiguous and every semantic-event context is a transitively closed cut;
7. snapshot reads never invoke computors or mutate graph/journal state.

A transport adapter may implement this abstraction using its existing mechanisms. Journal 3 does not prescribe those mechanisms.

## JournalSyncSource

```text
JournalSyncSource {
    openSnapshot() -> JournalSnapshot
}
```

Synchronization/reset obtains compatibility metadata from the returned held snapshot itself. An earlier mutable metadata query is insufficient.

A generic `JournalSyncSource` is not automatically safe for **writer continuation** after local rollback/loss. Continuing a writer identity requires the stronger recovery-source guarantee defined below.

## JournalPublication

Ordinary graph operations stage semantic intents before commit but do not reserve durable Journal coordinates early.

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
7. assigns every semantic event `(W,q)` own-writer context exactly `q-1`;
8. starts cross-writer context from the complete causally closed frontier semantically observed by the publication;
9. resolves same-publication references only to earlier records;
10. allocates AuthorityTimes which extend every causal predecessor;
11. writes Journal records and matching graph mutations atomically.

Failed operations consume no durable Journal coordinate.

## Context construction is semantic

A persisted event context is semantic history, not merely “writers explicitly referenced by this event.” If a publication observed B:7 and B:7 observed A:11, the new event context includes A through at least 11 even if the new event body directly references only B.

The only controlled exception is pre-Journal legacy-value conversion described by `incremental-graph-journal-migrations.md`: a bootstrap ValueEvent represents a historical legacy occurrence and deliberately does not claim causal observation of canonical bootstrap values merely because bootstrap code read the canonical artifact. This exception is not available to ordinary publication.

## JournalImportTarget

```text
JournalImportTarget {
    stageImportedRecord(record)
    stageLocalNormalizationIntent(...)
    validate()
    commitWithProjection()
}
```

Import validation rejects at least writer-prefix gaps, same-ID body disagreement, invalid current-version bytes, missing or non-transitively-closed contexts, wrong own-writer context, authority not extending causality, impossible ValueId references, malformed validation bases, and projection/invariant failure.

An imported record is never rewritten locally to repair those conditions. Staging may be incomplete during transfer, but unsupported partial history is never activated.

## Replay API

```text
projectJournal(snapshot, localWriter, graphSchema)
    -> ProjectedIncrementalGraphState
```

Production may use indexes/incremental folding/checkpoints, but an internal validation/rebuild path remains equivalent to full normative replay.

## Pairwise synchronization API

```text
synchronizeFrom(source: JournalSyncSource) -> Promise<SyncResult>
```

Success means source compatibility was checked from the held snapshot, source records were retained unchanged, all contexts are valid closed cuts, required normalization is included, and active graph equals active Journal replay.

A fully absent installation cannot call this operation because no receiver writer identity exists yet.

## Receiver-less absent-state restore API

Conceptually the configured installation recovery source has a stronger continuation contract than an arbitrary sync source:

```text
InstallationRecoverySource {
    query() ->
        Exists(ContinuationSafeSnapshot)
      | DefinitelyAbsent
      | IndeterminateOrError
}
```

`ContinuationSafeSnapshot` contains an ordinary stable Journal snapshot plus the semantic guarantee that, for its `localWriter = A`, the snapshot contains A's complete own stream through the greatest A coordinate ever durably published by the supported lifecycle.

A source which cannot guarantee that no longer A prefix exists elsewhere MUST return `IndeterminateOrError`. A merely lagging/readable copy is not sufficient to resume writer A.

Restoring an absent installation is then:

```text
restoreAbsentFrom(source: InstallationRecoverySource)
    -> Promise<RestoredDatabase>
```

The operation adopts `snapshot.localWriter`, restores retained history/projection/allocator state, creates no semantic history merely for restoration, and then hands the restored database to the normal migration gate.

If querying/opening known synchronized installation state fails, or own-writer completeness is indeterminate, startup fails. Fresh creation is separate and allowed only after definite absence.

The same continuation-safe guarantee is required by any same-writer recovery path before it may author another coordinate under a writer identity whose local state was behind/lost.

## Reset API

```text
resetTo(source: JournalSyncSource) -> Promise<ResetResult>
```

Reset requires an already-established writable receiver and uses one held compatible source snapshot plus the deterministic rules in `incremental-graph-journal-reset.md`.

Those rules include two maintenance-specific event uses:

- one occurrence-and-input-specific `InvalidateEvent(scope={kind:"proof", value:V, input:D})` for each currently-valid edge `D -> K` which reset intentionally removes while preserving V; and
- a value-scoped stale marker when reset target freshness is persistently stale while the occurrence's own effective proof is otherwise complete.

Proof-edge barriers are not ordinary explicit invalidation. They retire only the named edge of the named ValueId; concurrent barriers for different inputs compose by removing the union of those edges, while another ValueId is unaffected.

## Bootstrap/migration API boundary

Bootstrap/migration is owned by database lifecycle rather than an unrestricted journal writer API.

### CanonicalBootstrapSnapshot

The canonical pre-Journal basis is represented by a frozen lifecycle artifact, not an ordinary current Journal snapshot:

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

Laws:

1. `bootstrapFrontier` is exactly the creator frontier at the end of canonical bootstrap publication;
2. reads expose exactly records through that frontier and never post-bootstrap records;
3. the artifact is immutable while a software release claims support for that bootstrap target;
4. `databaseVersion` / `graphSchemeString` are the bootstrap target compatibility metadata;
5. the artifact is not interchangeable with a later `JournalSnapshot` containing it as a prefix;
6. Journal 3 does not require every future release to keep this old artifact format or legacy entry path supported forever.

### Bootstrap target is graph-semantic identity

A supported pre-Journal bootstrap target introduces Journal storage without first applying an ordinary graph/schema semantic migration.

Conceptually the bootstrap API consumes the already-persisted supported legacy graph directly. At the bootstrap cut it preserves exactly:

```text
present NodeKeys
NodeIdentifiers
payloads
createdAt / modifiedAt
freshness
validity
last_node_index
graph interpretation
```

A running release MUST NOT obtain this input by rerunning `MigrationStorage.create()`, `override()`, `invalidate()`, `delete()`, or another ordinary migration callback. In particular it must not generate execution-time timestamps or fresh allocator-dependent identities before canonical occurrence identity is established.

If reaching the configured bootstrap target would require such a semantic legacy migration, the transition is incompatible and fails `JournalVersionCompatibilityError` before bootstrap history is authored. Actual semantic/schema migration runs only after successful Journal bootstrap through the ordinary Journal-aware migration boundary.

### Cohort bootstrap source decision

Conceptually:

```text
CohortBootstrapSource {
    queryCanonicalBootstrap() ->
        Exists(CanonicalBootstrapSnapshot)
      | DefinitelyAbsent
      | IndeterminateOrError
}
```

Decision semantics:

- `Exists(B)` -> first require B version/schema to equal this release's expected semantic-identity bootstrap target; then if `B.creatorWriter == localFingerprint` and local state is pre-Journal, run creator-resume; otherwise run ordinary join;
- `DefinitelyAbsent` -> `createCanonicalBootstrap(legacyState)`;
- `IndeterminateOrError` -> fail; MUST NOT create.

A source may return `DefinitelyAbsent` only when that result is suitable for first-creator arbitration. Competing canonical artifacts are unsupported.

`createCanonicalBootstrap` durably establishes the immutable artifact before success is reported and before ordinary post-bootstrap Journal authoring begins.

### Canonical bootstrap operations

Conceptually:

```text
createCanonicalBootstrap(legacyState)
resumeCanonicalBootstrapCreator(legacyState, canonicalBootstrapSnapshot)
joinCanonicalBootstrap(legacyState, canonicalBootstrapSnapshot)
```

`createCanonicalBootstrap` journals the supported persisted legacy graph as the shared semantic basis once and freezes its final frontier as the canonical artifact. It does not run an ordinary graph migration callback before doing so.

`resumeCanonicalBootstrapCreator` is valid only when the local pre-Journal `DatabaseFingerprint` equals `artifact.creatorWriter`. It installs exactly the artifact's stream, validates the unchanged persisted legacy graph directly against the artifact projection under the semantic-identity bootstrap rule, reconstructs local writer head/allocator/high-water/projection, and atomically cuts over. It does not rerun a migration callback. Semantic disagreement is `JournalBootstrapForkError`; no new semantic history is authored merely to resume.

A different fingerprint cannot use creator-resume.

`joinCanonicalBootstrap` is **not reset**. It:

1. requires artifact version/schema to equal the running release's expected semantic-identity bootstrap target; mismatch is `JournalVersionCompatibilityError` before history is authored;
2. retains exactly the canonical records through `bootstrapFrontier`;
3. preserves the joining installation's own writer fingerprint/allocator state;
4. reuses canonical ValueIds for equal legacy occurrences;
5. converts local-only/different legacy occurrences into joining-writer `ValueEvent(reason="bootstrap")` records with authority seeded from their persisted legacy `modifiedAt` and without synthetic causal observation of canonical value events;
6. lets normal Journal authority resolve conflicting concurrent legacy occurrences;
7. for an exact shared occurrence, retains the canonical certificate as positive proof but intersects validity with the joining legacy evidence by adding `proof(value,input)` barriers for canonical edges the joining side lacks; it never strengthens canonical proof from joining-only evidence;
8. preserves shared stale state conservatively if either legacy side is stale, after proof-edge barriers are staged;
9. after direct proof/stale roots, persists recursive-only stale state over the selected dependency DAG using value-scoped bootstrap invalidations;
10. does not author a DeleteEvent merely because a node is absent from one legacy replica while present in the canonical basis.

A joining host does not emit a causally-later validation for an exact shared occurrence merely to strengthen its local legacy proof; doing so could clear canonical stale evidence solely because that host upgraded later.

Two independent joiners may assign different ValueIds to the same non-canonical legacy occurrence. That accepted trade-off is `$id-1635227135166767`; later conflict/certificate rules may stale dependents naming the losing occurrence.

The result need not equal the joining legacy graph at conflicting values. Upgrade time never overrides legacy `modifiedAt` conflict authority.

After bootstrap, lifecycle continues only through Journal-aware migration steps the running release explicitly supports. The API does not promise indefinite compatibility with an old bootstrap target.

### Journal-aware migration operations

```text
rewriteJournalFormat(...)
computeMigrationTarget(...)
applyRequiredSemanticMigration(...)
```

The representation rewrite is a canonical per-record transform over the **entire retained source-format record domain**, including history for node families removed from the target graph schema. If ValueEvent payload representation changes, one pure version-migration codec is applied identically to every retained affected ValueEvent regardless of selection or replica-local state. A migration without a deterministic representation for every retained source record is unsupported and fails before cutover.

For Journal-aware migration, representation-only rewrite is not expressed with legacy `override(nodeIdentifier,value)`. The codec is the single source of target bytes; a semantically preserved selected occurrence uses `keep`. The legacy value-producing override path is rejected once Journal history exists.

The semantic phase preserves existing ValueIds for occurrence-preserving decisions and appends only semantic records needed for the target state.

Maintenance proof/freshness has explicit internal semantics:

- true migration `invalidate(K)` remains node-scoped because it semantically invalidates K;
- when another migration transition removes currently-valid incoming proof for preserved occurrence V, author one `proof(value=V,input=D)` barrier for every removed edge D rather than invalidating the whole certificate;
- concurrent proof-edge barriers on the same V compose by subtracting the union of their named edges, so independently equivalent migrations do not destroy unrelated proof;
- when target state stores K stale while K's own selected effective proof is otherwise complete and covers its own value invalidations, ensure an uncovered value-scoped migration invalidation exists even if K is already recursively stale through an input.

Journal-aware migration does not require one canonical migration participant. Replicas may independently author distinct new ValueIds for genuine created/replaced occurrences; later synchronization may stale dependents whose certificates name a losing replacement occurrence.

These are lifecycle semantics, not a remote protocol definition.

## Error categories

Lifecycle/admin callers must distinguish at least:

```text
JournalForkError
JournalBootstrapForkError
JournalGapError
JournalCausalClosureError
JournalReferenceCausalityError
JournalRecordValidationError
JournalVersionCompatibilityError
JournalProjectionError
JournalPublicationError
JournalSourceReadError
```

The exact class names may differ except where a named lifecycle/migration category is referenced normatively; the semantic distinctions are normative.

## Locking ownership

Ordinary publications use the existing graph finalization/darkroom boundary.

Synchronization, reset, migration/bootstrap, absent restore, and projection rebuild use the existing exclusive maintenance lifecycle where they build/cut over large target state.

Journal 3 adds no independent lock hierarchy.