# IncrementalGraph Journal 3 Error Taxonomy

## Purpose

Journal 3 failures have different operational meanings. Implementations must not collapse incompatibility, forked identity, malformed history, projection failure, or storage failure into one generic error when lifecycle code needs to distinguish them.

Exact JavaScript class names may differ except where a named category is referenced normatively; the semantic distinctions below are required.

## JournalForkError

Meaning:

> Two records claim the same `(author, sequence)` identity but have different canonical current-format meaning.

Examples:

- receiver and source disagree on `A:42` body/context/authority;
- same-writer restoration discovers divergent overlap;
- two incorrectly migrated replicas produce different target bodies for one historical ID because replica-local state was used instead of canonical per-record rewrite.

Required behavior:

- do not merge by conflict authority or payload equality;
- do not rewrite either ID during ordinary sync/recovery;
- fail before active cutover.

A supported whole-database migration may deterministically rewrite representation while preserving one ID/historical meaning. That is not a fork.

## JournalBootstrapForkError

Meaning:

> A canonical bootstrap artifact belongs to this installation's continuing writer identity, but the still-local persisted pre-Journal graph no longer equals the semantic state from which that artifact was created.

This category exists for the crash window where canonical artifact publication succeeded but creator local Journal cutover did not.

Creator-resume requires:

```text
artifact.creatorWriter == local DatabaseFingerprint
semanticGraph(project(artifact, localWriter))
    == semanticGraph(local persisted legacy graph)
```

under the supported semantic-identity bootstrap interpretation.

The local comparison is direct: creator-resume does **not** rerun an ordinary migration callback or regenerate `create()` timestamps/identifiers.

Required behavior:

- do not append another bootstrap record;
- do not create another canonical artifact;
- do not reinterpret the creator as a foreign joiner;
- do not overwrite artifact history from mutable graph bytes;
- fail before active cutover and require explicit recovery/operator choice.

A different local fingerprint never uses creator-resume.

## JournalGapError

Meaning:

> A claimed committed writer prefix is not contiguous.

Example:

```text
A:1..40 and A:42 retained, A:41 missing
```

Staging may temporarily be incomplete, but active supported history may not expose a hole.

## JournalCausalClosureError

Meaning:

> A semantic-event context is not a genuine causally closed observed frontier.

Examples include:

```text
E.context[B] = 100
retained frontier B = 95
```

and:

```text
A:1
B:1 context={A:1}
C:1 context={B:1,A:0}
```

The second is malformed despite all named coordinates existing because C claims B while omitting A which B observed.

Also invalid:

- `F.context[F.author] != F.sequence - 1`;
- an included event's context is not componentwise included by F;
- happened-before does not imply later authority.

The controlled legacy-bootstrap ValueEvent exception may omit canonical foreign coordinates specifically so physical upgrade read order does not invent happened-before between pre-existing legacy values. Its actual stored context must still be closed over every coordinate it claims.

Never repair a malformed imported event by silently expanding its immutable context.

## JournalReferenceCausalityError

Meaning:

> A semantic event references a ValueId which was not in its causal past.

Examples:

- validation basis/target references concurrent or future ValueEvent;
- value-scoped invalidation names concurrent/future occurrence;
- proof-scoped barrier names concurrent/future occurrence.

Reject rather than substitute another ValueId or salvage only part of the event.

## JournalRecordValidationError

Meaning:

> A record cannot be decoded/validated under the replica's current `global/version` Journal contract.

Examples:

- malformed body/enums/timestamps;
- duplicate/noncanonical validation-basis inputs;
- ordinary validation using `"unknown"`;
- basis ValueId belongs to wrong NodeKey;
- validation target is not a ValueEvent for the same node;
- malformed NodeIdentifier;
- a `value` or `proof` invalidation scope names a non-ValueEvent or a ValueEvent for another node;
- use of proof scope outside its supported reset/migration maintenance meaning.

A historical certificate whose explicit input-key set differs from current schema is not corrupt solely for that reason; it is simply not current-shape-compatible proof.

There is no ordinary per-record version fallback.

## JournalVersionCompatibilityError

Meaning:

> Source/lifecycle state may be valid independently, but cannot be interpreted under the compatibility contract of the requested operation.

For ordinary synchronization/reset the held `JournalSnapshot` itself supplies:

```text
snapshot.databaseVersion
snapshot.graphSchemeString
```

For canonical bootstrap the frozen artifact supplies:

```text
canonical.databaseVersion
canonical.graphSchemeString
```

and these must exactly equal the running release's configured bootstrap target before create-resume/join interpretation.

A supported pre-Journal bootstrap target is additionally **graph-semantic identity** with the persisted source graph. Bootstrap may introduce Journal storage/database representation, but it must not need an ordinary semantic migration callback before occurrence identities are established.

Examples of incompatibility:

- ordinary source version/schema differs from receiver;
- earlier mutable metadata looked compatible but held snapshot now differs;
- bootstrap artifact version/schema differs from running release's expected target;
- current software no longer supports an old artifact target;
- current post-bootstrap snapshot is supplied instead of frozen canonical artifact;
- the configured legacy -> bootstrap target would require `MigrationStorage.create()`, `override()`, `invalidate()`, `delete()`, schema-semantic transformation, execution-time timestamps, allocator-dependent new graph identities, randomness, or another non-identity migration result before bootstrap.

The current legacy migration runner's `create()` is therefore not a valid pre-bootstrap conversion mechanism: it allocates a host-local identifier and execution-time timestamps. Such semantic changes may happen only before entering the supported bootstrap source state or after bootstrap as Journal-aware migration.

Required behavior:

- fail before interpreting/importing incompatible ordinary history or authoring bootstrap history;
- do not silently upcast/downcast individual records;
- do not rerun an incompatible legacy migration and hope it reproduces canonical state;
- do not fall back to fresh creation.

Journal 3 does not require arbitrary future releases to retain every historical bootstrap decoder/migration ladder forever.

## JournalProjectionError

Meaning:

> Structurally valid retained history cannot produce a supported IncrementalGraph projection, or a maintenance transition claims target equivalence but replay disagrees.

Examples:

- two selected semantic nodes reuse one incompatible physical NodeIdentifier;
- normalization should have established dependency closure but did not;
- reset/migration target replay differs from target;
- final sync/bootstrap state leaves a selected occurrence stale solely through a stale input without the required persistent marker.

Fail candidate cutover rather than treating mutable graph bytes as repair authority.

## JournalProjectionMismatchError

Meaning:

> Existing derived graph bytes disagree with `project(retainedJournal)` although authoritative history may be valid.

Ordinary graph exposure must not proceed while mismatch is known. Lifecycle may rebuild derived state; if replay itself fails, surface the underlying error.

## JournalPublicationError

Meaning:

> Durable graph+Journal publication/cutover failed operationally rather than semantically.

Examples:

- LevelDB batch/write failure;
- inactive-target flush failure;
- atomic active-pointer failure;
- canonical bootstrap artifact could not be durably established before ordinary authoring.

Supported active state never exposes only one side of graph/Journal publication.

If canonical artifact publication succeeds but creator local cutover fails, retry uses creator-resume rather than publishing another bootstrap history.

## JournalSourceReadError

Meaning:

> A required stable synchronization/reset/bootstrap source could not be opened/read completely for operational reasons.

Examples:

- I/O error opening snapshot metadata;
- I/O error streaming required suffix;
- stable source becomes unavailable before required range is read;
- cohort source reports artifact exists but exact frozen cut cannot be read.

Staged partial state is not activated. Failure to read known canonical artifact does not authorize another canonical creation.

A readable but incompatible source uses `JournalVersionCompatibilityError` instead.

## Invalid migration decision

The existing migration framework may reject a Journal-aware `override()` whose callback result differs from canonical per-record target rewrite.

This is a migration-definition/decision failure rather than writer fork because no divergent record body becomes active. Implementations may surface existing `InvalidMigrationDecisionError`.

## Invalid local writer continuation

If a writable Journal database is behind a surviving longer exact prefix of its own writer stream, supported response is same-writer recovery before new local allocation.

Divergent overlap is `JournalForkError`.

This is distinct from pre-Journal creator-resume where no local Journal history has become active yet.

## User-facing error expectations

Ordinary `pull()`/`invalidate()` need not expose every internal category unless failure crosses their transaction boundary.

Lifecycle/administrative callers should distinguish at least:

```text
retryable operational failure
vs compatibility / use-supported-version-first
vs rebuildable derived-state mismatch
vs authoritative corruption/fork
```

Messages should identify relevant writer/sequence/node/version/schema where practical and must not call immutable writer-history disagreement an ordinary graph conflict.