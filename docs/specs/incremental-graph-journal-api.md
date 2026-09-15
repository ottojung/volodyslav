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

A persisted event context is semantic history, not merely “writers explicitly referenced by this event.” If a publication observed B:7 and B:7 observed A:11, the new event context includes A through at least 11 even if the new event directly references only B.

The only controlled exception is pre-Journal legacy-value conversion described by `incremental-graph-journal-migrations.md`: a bootstrap ValueEvent represents a historical legacy occurrence and deliberately does not claim causal observation of canonical bootstrap values merely because migration code read the canonical artifact. This exception is not available to ordinary publication.

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

```text
restoreAbsentFrom(source: InstallationRecoverySource)
    -> Promise<RestoredDatabase>
```

`InstallationRecoverySource` is the configured transport-neutral source for this installation's own synchronized state.

The operation adopts `snapshot.localWriter`, restores retained history/projection/allocator state, creates no semantic history merely for restoration, and then hands the restored database to the normal migration gate.

If querying/opening known synchronized installation state fails, startup fails. Fresh creation is separate and allowed only after definite absence.

## Reset API

```text
resetTo(source: JournalSyncSource) -> Promise<ResetResult>
```

Reset requires an already-established writable receiver and uses one held compatible source snapshot plus the minimal deterministic rules in `incremental-graph-journal-reset.md`.

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

1. `bootstrapFrontier` is exactly the creator frontier at the end of the canonical bootstrap publication;
2. reads expose exactly records through that frontier and never post-bootstrap records;
3. the artifact stays immutable even when the cohort later authors Journal history or migrates active databases;
4. `databaseVersion` / `graphSchemeString` are the original bootstrap target compatibility metadata;
5. the artifact is not interchangeable with a later `JournalSnapshot` which merely contains the bootstrap records as a prefix.

### Cohort bootstrap source decision

Conceptually the lifecycle has:

```text
CohortBootstrapSource {
    queryCanonicalBootstrap() ->
        Exists(CanonicalBootstrapSnapshot)
      | DefinitelyAbsent
      | IndeterminateOrError
}
```

The source-discovery/carry mechanism is outside Journal semantics. The decision semantics are normative:

- `Exists(snapshot)` -> validate exact bootstrap-target version/schema, then `joinCanonicalBootstrap(legacyState, snapshot)`;
- `DefinitelyAbsent` -> `createCanonicalBootstrap(legacyState)`;
- `IndeterminateOrError` -> fail; MUST NOT create.

A source may return `DefinitelyAbsent` only when that result is suitable for first-creator arbitration. Competing canonical artifacts are unsupported.

`createCanonicalBootstrap` does not complete until the immutable canonical artifact is durably established. Ordinary post-bootstrap Journal authoring begins only afterward.

### Canonical bootstrap operations

```text
createCanonicalBootstrap(legacyState)
joinCanonicalBootstrap(legacyState, canonicalBootstrapSnapshot)
```

`createCanonicalBootstrap` authors the shared semantic basis once and freezes its final frontier as the canonical artifact.

`joinCanonicalBootstrap` is **not reset**. It:

1. requires the artifact's exact `databaseVersion` / `graphSchemeString` to equal the supported legacy->Journal bootstrap target; mismatch throws/returns `JournalVersionCompatibilityError` before history is authored;
2. retains exactly the canonical records through `bootstrapFrontier`;
3. preserves the joining installation's own writer fingerprint/allocator state;
4. reuses canonical ValueIds for equal legacy occurrences;
5. converts local-only/different legacy occurrences into joining-writer `ValueEvent(reason="bootstrap")` records with authority seeded from their own legacy `modifiedAt` and without synthetic causal observation of canonical value events;
6. lets normal Journal authority resolve conflicting concurrent legacy occurrences;
7. establishes required bootstrap proof/freshness metadata only after the value occurrences exist;
8. does not author a DeleteEvent merely because a node is absent from one legacy replica while present in the canonical basis.

The result need not equal the joining legacy graph at conflicting values: conflict authority decides. Upgrade time never overrides the legacy modifiedAt policy.

After installing the bootstrap-target database, lifecycle code runs the ordinary supported Journal-aware migration chain to the running version. Post-bootstrap cohort history is imported later only through ordinary compatible synchronization.

### Journal-aware migration operations

```text
rewriteJournalFormat(...)
computeMigrationTarget(...)
applyRequiredSemanticMigration(...)
```

The representation rewrite is a canonical per-record transform. If ValueEvent payload representation changes, one pure version-migration codec is applied identically to every retained affected ValueEvent regardless of selection or replica-local state.

The semantic phase preserves existing ValueIds for occurrence-preserving decisions and appends only semantic records needed for the target state.

`override()` is occurrence-preserving, but its callback is not authoritative record-rewrite input for Journal-aware history. Its selected-record result must equal the canonical per-record codec output; otherwise migration fails with the migration framework's invalid-decision error before cutover.

Journal-aware migration does not require one canonical migration participant. Replicas may independently author distinct new ValueIds for genuine created/replaced occurrences; later synchronization may stale dependents whose certificates name a losing replacement occurrence.

These are lifecycle semantics, not a remote protocol definition.

## Error categories

Lifecycle/admin callers must distinguish at least:

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

Migration may additionally surface the existing `InvalidMigrationDecisionError` when a Journal-aware `override()` disagrees with the canonical per-record rewrite.

The exact class names may differ except where an existing migration error type is referenced; the semantic distinctions are normative.

## Locking ownership

Ordinary publications use the existing graph finalization/darkroom boundary.

Synchronization, reset, migration/bootstrap, absent restore, and projection rebuild use the existing exclusive maintenance lifecycle where they build/cut over large target state.

Journal 3 adds no independent lock hierarchy.
