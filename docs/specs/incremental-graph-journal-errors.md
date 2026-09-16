# IncrementalGraph Journal 3 Error Taxonomy

## Purpose

Journal 3 failures have different operational meanings. Implementations must not collapse them into one generic synchronization/corruption error when lifecycle code needs to distinguish incompatibility, forked identity, malformed history, projection failure, or ordinary storage failure.

Exact JavaScript class names may differ except where a named category is referenced normatively; the semantic distinctions below are required.

## JournalForkError

Meaning:

> Two records claim the same `(author, sequence)` identity but have different canonical current-format meaning.

Examples:

- receiver and source disagree on `A:42` body;
- body/context/authority differs for one ID;
- same-writer restoration discovers divergent overlapping prefixes;
- two incorrectly migrated replicas produce different target bodies for the same historical ID because replica-local state was used instead of the canonical per-record migration codec.

Required behavior:

- do not merge by conflict authority;
- do not compare payloads to choose one;
- do not rewrite either record ID during ordinary sync/recovery;
- fail before active cutover.

A supported database migration may deterministically rewrite representation of both copies from one whole-database version to another while preserving the same ID/historical meaning. That controlled format migration is not a fork.

## JournalBootstrapForkError

Meaning:

> The canonical bootstrap artifact is owned by this installation's continuing writer identity, but the still-local pre-Journal database no longer describes the semantic state from which that artifact was created.

This error exists for the crash window where the canonical artifact became durable but the creator's local Journal cutover did not.

Creator-resume requires:

```text
artifact.creatorWriter == local DatabaseFingerprint
semanticGraph(project(artifact, localWriter))
    == semanticGraph(local legacy state interpreted at artifact target)
```

If writer identity matches but semantic equality does not, the lifecycle cannot safely decide that the local legacy state and artifact are one continuing history.

Required behavior:

- do not append another bootstrap record;
- do not create a second canonical artifact;
- do not treat the local legacy graph as a foreign joining replica;
- do not overwrite the canonical artifact from mutable local graph bytes;
- fail before active cutover and require explicit recovery/operator choice.

A different local fingerprint never uses creator-resume; it follows ordinary bootstrap join instead.

## JournalGapError

Meaning:

> A claimed committed writer prefix is not contiguous.

Example:

```text
A:1..40 and A:42 retained, A:41 missing
```

Required behavior:

- staging may temporarily be incomplete while transfer is in progress;
- an active supported JournalReplica may not expose the gap;
- final validation fails if the range cannot be completed.

## JournalCausalClosureError

Meaning:

> A semantic event context is not a genuine causally closed observed frontier for the causal history that event claims.

This category covers both missing retained coordinates and transitive-context omissions.

Examples:

```text
E.context[B] = 100
retained frontier B = 95
```

and:

```text
A:1
B:1 context = { A:1 }
C:1 context = { B:1, A:0 }
```

The second history is malformed even though all named coordinates are retained: C:1 claims to have observed B:1 while omitting A:1, which B:1 had already observed.

For semantic event F=(W,q), these are also causal-closure violations:

- `F.context[W] != q - 1`;
- some semantic E included by F's context has an `E.context[A]` coordinate greater than `F.context[A]`;
- `happenedBefore(E,F)` but F's authority does not compare later than E's authority.

The controlled legacy-bootstrap conversion rule may omit canonical foreign coordinates from a joining legacy ValueEvent specifically so migration execution read order does not invent happened-before between pre-existing legacy values. Such an event remains well formed only if its actual context is itself closed and its authority extends every predecessor it does claim.

Required behavior:

- complete missing records only when the source snapshot itself supplies the absent prefix and the candidate event context then satisfies closure;
- never repair a transitive omission by silently expanding an immutable imported event's context;
- reject the final active target if the event itself encodes a non-closed context.

## JournalReferenceCausalityError

Meaning:

> A semantic event references a ValueId which was not actually in its causal past.

Examples:

- ValidateEvent basis references a concurrent ValueEvent;
- validation targets a future same-writer value;
- value-scoped invalidation names a concurrent/future occurrence.

Required behavior:

- reject the record/history;
- do not substitute another current ValueId;
- do not salvage only the non-bad basis entries.

## JournalRecordValidationError

Meaning:

> A record cannot be decoded/validated according to the replica's current `global/version` journal contract.

Examples:

- bytes/body shape not valid for current database version;
- malformed fields;
- invalid timestamps;
- duplicate validation-basis input NodeKeys;
- validation-basis entries not in canonical current-version NodeKeyString order;
- ordinary validation using `"unknown"`;
- known basis ValueId names a ValueEvent for a different semantic input NodeKey;
- validation target ValueId names a non-ValueEvent or wrong semantic node;
- invalid NodeIdentifier representation.

A historical certificate whose explicit input-key set differs from the **current** schema is not malformed solely for that reason. It remains valid historical evidence; replay simply does not treat it as current-shape-compatible proof.

There is no ordinary per-record version fallback. Source-version bytes are read only by the explicit database migration path for that source `global/version`; a current replica containing mixed old/new record formats is unsupported.

Required behavior:

- fail before activating malformed history;
- surface enough record identity/context to diagnose the bad record without leaking unrelated payloads unnecessarily.

## JournalVersionCompatibilityError

Meaning:

> A held source/lifecycle artifact and the requested receiver or migration transition may each be valid independently, but they cannot be interpreted under the compatibility contract required by that operation.

For ordinary synchronization/reset, compatibility is determined from the held `JournalSnapshot` itself:

```text
snapshot.databaseVersion
snapshot.graphSchemeString
```

For pre-Journal canonical bootstrap, compatibility is determined from the frozen `CanonicalBootstrapSnapshot`:

```text
canonical.databaseVersion
canonical.graphSchemeString
```

and those fields must equal the running release's configured expected bootstrap target version/schema before creator-resume or ordinary join may interpret the artifact.

Examples:

- source snapshot `databaseVersion` differs from receiver active `global/version`;
- source snapshot `graphSchemeString` differs from receiver active `global/graph_scheme`;
- an earlier mutable metadata check passed but the held snapshot now exposes another version/schema;
- a cohort bootstrap artifact is encoded for a version/schema other than the running release's expected bootstrap target;
- current software no longer supports the historical bootstrap target used by an old artifact;
- an implementation tries to use a current post-bootstrap Journal snapshot as canonical bootstrap input instead of the frozen bootstrap artifact.

This is incompatibility, not corruption.

Required behavior:

- compare compatibility metadata from the held ordinary source snapshot before interpreting/importing records or deriving reset target;
- compare canonical bootstrap artifact metadata before interpreting the cut or authoring/resuming bootstrap history;
- do not trust a compatibility check performed against a different mutable source state;
- do not attempt per-record upcast/downcast or implicit migration inside ordinary sync/reset/bootstrap join;
- do not activate staged source/bootstrap history when the check fails.

Journal 3 does not require future releases to preserve arbitrary historical bootstrap-target decoders and migration chains forever. An operator may need to run software which explicitly supports the historical target before upgrading further.

## JournalProjectionError

Meaning:

> Retained current-format history is structurally journal-valid, but deterministic replay cannot produce a supported IncrementalGraph projection.

Examples:

- two current semantic nodes select one incompatible physical NodeIdentifier;
- target replay violates a required graph materialization/storage invariant after normalization should have handled it;
- a migration/reset claims target equivalence but replayed target differs.

Required behavior:

- fail candidate operation/rebuild/cutover;
- do not repair by treating mutable graph bytes as additional authority.

## JournalProjectionMismatchError

Meaning:

> Existing materialized graph bytes are known to disagree with `project(retainedJournal)`.

This differs from JournalProjectionError: authoritative history may be valid while derived graph state is damaged/stale.

Required behavior:

- ordinary graph exposure must not proceed while mismatch is known;
- lifecycle may invoke projection rebuild;
- if rebuild succeeds, journal history is unchanged;
- if replay itself then fails, surface underlying projection/journal error instead.

## JournalPublicationError

Meaning:

> Durable graph+journal publication/cutover failed for operational/storage reasons rather than semantic incompatibility.

Examples:

- LevelDB batch/write failure;
- inactive-target flush failure;
- atomic active-pointer/cutover failure;
- canonical bootstrap cut could not be durably established before creator would begin ordinary Journal authoring.

Required behavior depends on publication boundary, but must preserve:

```text
no supported active state exposes only one side of graph/journal publication
```

A failed ordinary transaction consumes no durable journal sequence position.

If canonical artifact publication succeeds but creator local cutover fails, retry follows the creator-resume path rather than publishing a second bootstrap history.

## JournalSourceReadError

Meaning:

> A required stable synchronization/reset/bootstrap source artifact could not be opened or read completely for operational reasons.

Examples:

- I/O error while opening/reading an ordinary snapshot's compatibility metadata;
- I/O error while streaming an otherwise valid suffix;
- source snapshot unexpectedly unavailable before required ranges are read;
- configured cohort bootstrap source says an artifact exists but its exact frozen cut cannot be read.

Required behavior:

- staged partial records are not activated;
- existing receiver remains supported;
- retry may resume/restart according to implementation-specific staging behavior, but semantics are unchanged;
- failure to read a known canonical bootstrap artifact does not fall back to creating another one.

A readable source/artifact with incompatible version/schema uses `JournalVersionCompatibilityError`, not `JournalSourceReadError`.

## Invalid migration decision

The existing migration framework may reject a Journal-aware `override()` whose callback result differs from canonical per-record target payload rewrite.

This is a migration-definition/decision error, not a writer fork: no divergent target record becomes active. Implementations may surface existing `InvalidMigrationDecisionError` from `migration.md`.

## Invalid local writer continuation

A special lifecycle condition occurs when a writable Journal database attempts new authoring while a longer surviving exact prefix of its own writer stream is known elsewhere.

The supported response is same-writer prefix recovery under maintenance before new local allocation.

If exact prefix recovery is impossible because overlap differs, surface `JournalForkError`.

This is distinct from pre-Journal creator-resume, where local Journal history has not yet become active.

Implementations may expose a dedicated `JournalWriterBehindError` before recovery is attempted, but such a category is optional.

## User-facing error expectations

Ordinary application `pull()`/`invalidate()` need not expose the full internal journal taxonomy unless failure crosses their transaction boundary.

Lifecycle/administrative synchronization, reset, migration, startup, and rebuild should preserve enough category information that callers can distinguish:

```text
retryable operational failure
vs migrate-first incompatibility
vs rebuildable derived-state mismatch
vs authoritative corruption/fork
```

Error messages should identify relevant writer/sequence/node/database version or schema mismatch where possible.

They must not claim a graph conflict when actual problem is immutable writer-history disagreement.
