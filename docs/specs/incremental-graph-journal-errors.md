# IncrementalGraph Journal 3 Error Taxonomy

## Purpose

Journal 3 failures have different operational meanings. Lifecycle code must not collapse incompatibility, unsupported lifecycle state, forked identity, malformed history, projection failure, or storage failure into one generic error.

Exact JavaScript class names may differ except where a category is referenced normatively. The semantic distinctions below are required.

## JournalForkError

Meaning:

> Two records claim the same `(author, sequence)` identity but have different canonical current-format meaning.

Examples:

- receiver/source disagree on `A:42`;
- two supported histories expose conflicting bodies for one writer coordinate;
- two migrations rewrote one historical ID differently because the format transform depended on replica-local state.

Required behavior: do not merge by graph conflict authority or payload equality; fail before cutover.

A deterministic whole-database format rewrite which preserves the ID/historical fact is not a fork.

## JournalBootstrapForkError

Meaning:

> A canonical bootstrap artifact belongs to this installation's continuing writer identity, but the still-local pre-Journal graph no longer equals the semantic state represented by that artifact.

Creator-resume requires the local fingerprint to equal `artifact.creatorWriter` and direct persisted-state equality under the semantic-identity bootstrap contract. It does not rerun migration callbacks or regenerate identifiers/timestamps.

On mismatch: author nothing, do not create another canonical artifact, and require explicit recovery/operator action.

## JournalGapError

Meaning:

> A claimed committed writer prefix is not contiguous.

Staging may temporarily be incomplete; active supported history may not expose a hole.

## JournalCausalClosureError

Meaning:

> A semantic-event context is not a genuine causally closed frontier.

Invalid examples include:

```text
A:1
B:1 context={A:1}
C:1 context={B:1,A:0}
```

or `F.context[F.author] != F.sequence - 1`.

The narrow historical bootstrap-value exception may omit canonical foreign coordinates so upgrade read order does not invent legacy causality; its stored context must still be closed over every coordinate it actually claims.

Never silently expand an immutable imported context to repair it.

## JournalReferenceCausalityError

Meaning:

> An event references a ValueId which was not in its causal past.

Examples:

- validation target/basis names a concurrent or future ValueEvent;
- `value(V)` invalidation names a concurrent/future/wrong-node occurrence;
- `proof(V,D)` barrier names a concurrent/future/wrong-node occurrence.

Reject rather than substituting another ValueId or salvaging only part of the event.

## JournalRecordValidationError

Meaning:

> A record cannot be decoded or validated under the current Journal format contract.

Examples:

- malformed enums/timestamps/body;
- duplicate/noncanonical validation-basis inputs;
- ordinary validation using `"unknown"`;
- basis ValueId belongs to the wrong input NodeKey;
- validation target is not a ValueEvent for the same node;
- malformed NodeIdentifier;
- a `value`/`proof` scope names a non-ValueEvent or another node;
- a proof scope omits its semantic input NodeKey or uses proof scope outside controlled bootstrap/reset/migration maintenance.

A historical certificate whose explicit input-key set differs from current schema is not corrupt merely for that reason; it is simply not current-shape-compatible proof.

## JournalVersionCompatibilityError

Meaning:

> Independently valid state cannot be interpreted under the compatibility contract of the requested operation.

For sync/reset, compatibility metadata comes from the exact held `JournalSnapshot`. For canonical bootstrap it comes from the frozen canonical artifact.

Examples:

- source version/schema differs from receiver;
- an earlier mutable metadata read matched but the held snapshot does not;
- bootstrap artifact version/schema differs from the release's supported bootstrap target;
- current software no longer supports that historical bootstrap target;
- a current post-bootstrap snapshot is supplied where the original canonical bootstrap cut is required;
- pre-Journal bootstrap would require a semantic/time/allocator-dependent migration before Journal identity is established;
- a Journal-aware format migration's codec is not total over retained source-version history, including retained records for node families absent from the target schema;
- the source->target `rewriteNodeKey` definition is non-injective over valid source semantic NodeKeys which may occur in supported source-version history; a locally observed collision is one concrete witness, but the incompatibility is codec-level even when colliding keys reside on different replicas.

Fail before incompatible history is interpreted/authored or a migration target is cut over. Do not fall back to fresh creation.

## JournalWriterBehindError

This category names the established-writer rollback condition defined normatively in `incremental-graph-journal-lifecycle.md` §5. Ordinary synchronization handling is defined in `incremental-graph-journal-sync.md` §Receiver-local writer ahead in the source is unsupported state; reset handling is defined in `incremental-graph-journal-reset.md` §Preconditions.

The taxonomy does not define a separate recovery rule: this error is not a request to repair an existing receiver by importing its missing own-writer suffix.

## JournalProjectionError

Meaning:

> Structurally valid retained history cannot produce the required supported IncrementalGraph projection, or a maintenance transition claims target equivalence but replay disagrees.

Examples:

- selected NodeIdentifier collision;
- dependency closure normalization missing;
- reset/migration target replay differs from target;
- bootstrap/sync/reset/migration leaves a persistent stale transition unrecorded;
- maintenance proof-edge barriers do not reproduce the intended validity-edge set.

Fail candidate cutover; mutable graph bytes are not repair authority.

## JournalProjectionMismatchError

Meaning:

> Existing derived graph bytes disagree with `project(retainedJournal)` while authoritative history may still be valid.

Ordinary graph exposure stops until derived state is rebuilt/validated. If replay itself fails, surface the underlying authoritative error.

## JournalPublicationError

Meaning:

> Durable graph+Journal publication/cutover failed operationally rather than semantically.

Examples include storage batch/flush/active-pointer failure and failure to durably establish the canonical bootstrap artifact before ordinary post-bootstrap authoring.

If canonical artifact publication succeeded but creator cutover failed, retry uses creator-resume rather than publishing duplicate bootstrap history.

## JournalSourceReadError

Meaning:

> A required stable source could not be opened/read completely for operational reasons.

Examples:

- snapshot metadata/range I/O error;
- source disappears before required range is read;
- cohort source says canonical artifact exists but the exact frozen cut cannot be read;
- absent-installation recovery source cannot deliver the continuation-safe snapshot it claimed.

Partial staged state is not activated. Failure to read a known canonical artifact does not authorize another canonical creation.

## InvalidMigrationDecisionError

The existing migration framework may reject a migration decision whose semantic/cache-state contract is unsupported, such as an invalid `create()` assertion.

A non-total Journal format codec is **not** this category; it is `JournalVersionCompatibilityError` because the source/target database versions do not define a complete retained-history representation transition.

## User-facing error expectations

Ordinary `pull()`/`invalidate()` need not expose every internal class unless the failure crosses their transaction boundary.

Lifecycle/administrative callers should distinguish at least:

```text
retryable operational failure
vs compatibility / use-supported-version-first
vs unsupported writer-behind / lifecycle corruption
vs rebuildable derived-state mismatch
vs authoritative corruption/fork
```

Messages should identify relevant writer/sequence/node/version/schema where practical and must not call immutable writer-history disagreement an ordinary graph conflict.
