# IncrementalGraph Journal 3 Error Taxonomy

## Purpose

Journal 3 failures have different operational meanings. Implementations must not collapse them into one generic synchronization/corruption error when lifecycle code needs to distinguish incompatibility, forked identity, malformed history, projection failure, or ordinary storage failure.

Exact JavaScript class names may differ, but the categories below are normative.

## JournalForkError

Meaning:

> Two records claim the same `(author, sequence)` identity but have different canonical current-format meaning.

Examples:

- receiver and source disagree on `A:42` body;
- body/context/authority differs for one ID;
- same-writer restoration discovers divergent overlapping prefixes.

Required behavior:

- do not merge by conflict authority;
- do not compare payloads to choose one;
- do not rewrite either record ID during ordinary sync/recovery;
- fail the operation before active cutover.

A supported database migration may deterministically rewrite the representation of both copies from one whole-database version to another while preserving the same ID/historical meaning. That controlled format migration is not a fork.

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

> A semantic event context is not a genuine causally closed observed frontier.

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

- bytes/body shape not valid for the current database version;
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

> The source snapshot and receiver may each be valid independently, but ordinary synchronization/reset cannot interpret them under one compatible current database/schema/record model.

Compatibility is determined from the **held `JournalSnapshot` itself**:

```text
snapshot.databaseVersion
snapshot.graphSchemeString
```

These fields are the exact source `global/version` value and exact persisted `global/graph_scheme` string from the same committed source state as the snapshot's journal frontier/records.

Examples:

- source snapshot `databaseVersion` differs from the receiver's active `global/version` and requires migration first;
- source snapshot `graphSchemeString` differs exactly from the receiver's active `global/graph_scheme` string;
- a caller previously observed compatible source metadata, but the source migrated before `openSnapshot()` and the held snapshot now exposes different version/schema metadata.

This is incompatibility, not corruption.

Required behavior:

- compare compatibility metadata from the held source snapshot before interpreting/importing its records or deriving a reset target;
- do not trust a compatibility check performed against a different mutable source state before `openSnapshot()`;
- do not attempt per-record upcast/downcast or implicit migration inside ordinary sync/reset;
- do not activate any staged source history when the check fails;
- lifecycle may migrate one/both sides through the supported whole-database migration path, then retry.

## JournalProjectionError

Meaning:

> Retained current-format history is structurally journal-valid, but deterministic replay cannot produce a supported IncrementalGraph projection.

Examples:

- two current semantic nodes select one incompatible physical NodeIdentifier;
- target replay violates a required graph materialization/storage invariant after normalization should have handled it;
- a migration/reset claims target equivalence but replayed target differs.

Required behavior:

- fail the candidate operation/rebuild/cutover;
- do not repair by treating mutable graph bytes as additional authority.

## JournalProjectionMismatchError

Meaning:

> Existing materialized graph bytes are known to disagree with `project(retainedJournal)`.

This differs from JournalProjectionError: authoritative history may be perfectly valid, while derived graph state is damaged/stale.

Required behavior:

- ordinary graph exposure must not proceed while mismatch is known;
- lifecycle may invoke the supported projection-rebuild path;
- if rebuild succeeds, journal history is unchanged;
- if replay itself then fails, surface the underlying projection/journal error instead.

## JournalPublicationError

Meaning:

> Durable graph+journal publication/cutover failed for operational/storage reasons rather than semantic incompatibility.

Examples:

- LevelDB batch/write failure;
- inactive-target flush failure;
- atomic active-pointer/cutover failure.

Required behavior depends on the publication boundary, but must preserve this invariant:

```text
no supported active state exposes only one side of graph/journal publication
```

A failed ordinary transaction consumes no durable journal sequence position.

## JournalSourceReadError

Meaning:

> A stable synchronization/reset source snapshot could not be opened or read completely for operational reasons.

Examples:

- I/O error while opening/reading the snapshot's compatibility metadata;
- I/O error while streaming an otherwise valid suffix;
- source snapshot unexpectedly unavailable before required ranges are read.

Required behavior:

- staged partial records are not activated;
- existing receiver remains supported;
- retry may resume/restart according to implementation-specific staging behavior, but semantics are unchanged.

A source which is readable but exposes incompatible `databaseVersion`/`graphSchemeString` uses `JournalVersionCompatibilityError`, not `JournalSourceReadError`.

## Invalid local writer continuation

A special lifecycle condition occurs when a writable database attempts new authoring while a longer surviving exact prefix of its own writer stream is known to exist elsewhere.

The supported response is to perform same-writer prefix recovery under maintenance before new local allocation.

If exact prefix recovery is impossible because overlap differs, surface `JournalForkError`.

Implementations may expose a dedicated `JournalWriterBehindError` before recovery is attempted, but such a category is optional; the underlying semantic distinction is exact-prefix-behind versus forked-history.

## User-facing error expectations

Ordinary application `pull()`/`invalidate()` need not expose the full internal journal taxonomy unless the failure crosses their transaction boundary.

Lifecycle/administrative synchronization, reset, migration, startup, and rebuild should preserve enough category information that callers can distinguish:

```text
retryable operational failure
vs migrate-first incompatibility
vs rebuildable derived-state mismatch
vs authoritative corruption/fork
```

Error messages should identify the relevant writer/sequence/node/database version or schema mismatch where possible.

They must not claim a graph conflict when the actual problem is immutable writer-history disagreement.