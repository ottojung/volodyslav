# IncrementalGraph Journal 3 Error Taxonomy

## Purpose

Journal 3 failures have different operational meanings. Implementations must not collapse them into one generic synchronization/corruption error when lifecycle code needs to distinguish incompatibility, forked identity, malformed history, projection failure, or ordinary storage failure.

Exact JavaScript class names may differ, but the categories below are normative.

## JournalForkError

Meaning:

> Two records claim the same `(author, sequence)` identity but have different canonical meaning.

Examples:

- receiver and source disagree on `A:42` body;
- record version/body/context/authority differs for one ID;
- same-writer restoration discovers divergent overlapping prefixes.

Required behavior:

- do not merge by conflict authority;
- do not compare payloads to choose one;
- do not rewrite either record ID;
- fail the operation before active cutover.

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

> A retained semantic event claims causal observation not covered by the retained journal.

Example:

```text
E.context[B] = 100
retained frontier B = 95
```

Required behavior:

- fetch/complete missing required source history if it is part of the same valid source snapshot and transfer is still in staging;
- otherwise reject the final active target.

## JournalReferenceCausalityError

Meaning:

> A semantic event references a ValueId which was not actually in its causal past.

Examples:

- ValidateEvent basis references concurrent ValueEvent;
- validation targets a future same-writer value;
- value-scoped invalidation names a concurrent/future occurrence.

Required behavior:

- reject the record/history;
- do not substitute another current ValueId;
- do not salvage only the non-bad basis positions.

## JournalRecordValidationError

Meaning:

> A record cannot be decoded/validated according to its persisted record version and kind contract.

Examples:

- unknown unsupported record version;
- malformed fields;
- invalid timestamps;
- validation basis wrong arity under its applicable interpretation;
- ValueId names non-ValueEvent or wrong semantic node;
- invalid NodeIdentifier representation.

Required behavior:

- fail before activating the history;
- surface enough record identity/context to diagnose the bad record without leaking unrelated payloads unnecessarily.

## JournalVersionCompatibilityError

Meaning:

> Each side may be valid independently, but ordinary synchronization/reset cannot interpret them under one compatible current database/schema/record model.

Examples:

- source current database version differs and requires migration first;
- source schema is not compatible with the receiver's current replay interpretation.

This is incompatibility, not corruption.

Required behavior:

- do not attempt implicit migration inside ordinary sync;
- lifecycle may migrate one/both sides through the supported migration path, then retry.

## JournalProjectionError

Meaning:

> Retained history decodes and is structurally journal-valid, but deterministic replay cannot produce a supported IncrementalGraph projection.

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

> A stable synchronization/reset source could not be read completely for operational reasons.

Examples:

- I/O error while streaming an otherwise valid suffix;
- source snapshot unexpectedly unavailable before required ranges are read.

Required behavior:

- staged partial records are not activated;
- existing receiver remains supported;
- retry may resume/restart according to implementation-specific staging behavior, but semantics are unchanged.

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

Error messages should identify the relevant writer/sequence/node/version where possible.

They must not claim a graph conflict when the actual problem is immutable writer-history disagreement.
