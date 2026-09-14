# Specification for IncrementalGraph Synchronization

## Status and scope

For database versions using Journal 3, synchronization is journal replication followed by deterministic replay/projection.

The semantic protocol is defined by:

- `incremental-graph-journal.md`;
- `incremental-graph-journal-types.md`;
- `incremental-graph-journal-sync.md`;
- `incremental-graph-journal-replay.md`;
- `incremental-graph-journal-api.md`; and
- `incremental-graph-journal-locking.md`.

This document defines the surrounding IncrementalGraph lifecycle obligations. It intentionally does not specify a concrete remote/backend protocol or change how an existing transport carries snapshots.

The public `pull()` and `invalidate()` semantics remain defined by the ordinary IncrementalGraph specifications.

## Journal-first synchronization

A Journal 3 database consists semantically of:

```text
retained immutable journal history
+ derived materialized graph projection
```

Normal synchronization does not merge `values`, `freshness`, `timestamps`, `valid`, or `identifiers_keys_map` as independent authorities.

Instead, one pairwise synchronization:

1. opens one stable source `JournalSnapshot`;
2. streams every writer suffix missing from the receiver;
3. validates immutable overlap and prefix integrity;
4. forms the target retained history by prefix union;
5. performs the synchronization normalization required by `incremental-graph-journal-sync.md`;
6. deterministically replays/projects the resulting history;
7. validates ordinary IncrementalGraph invariants;
8. atomically publishes the target journal and matching graph projection.

A receiver with zero retained history follows the same operation from frontier zero. There is no separate semantic full-sync algorithm.

## Preconditions

A target may be committed only when:

- source and receiver Journal 3 record interpretations are compatible;
- their current database/schema versions are compatible for ordinary synchronization;
- every retained writer history is one contiguous immutable prefix;
- overlapping `JournalRecordId`s have identical canonical meaning;
- the final retained frontier is causally closed;
- any same-writer missing suffix is an exact continuation rather than a conflicting fork;
- every record/payload needed by replay is present;
- synchronization normalization has made selected present heads dependency-closed;
- every current validation certificate is interpreted through its explicit input NodeKeys rather than historical positional schema ordering;
- the resulting projection satisfies ordinary IncrementalGraph storage/`oldValue` invariants.

Malformed/conflicting history is rejected rather than repaired with payload equality, transport ancestry, timestamp preference, or arbitrary source preference.

## Computor prohibition

Synchronization MUST NOT invoke computors.

All synchronized value occurrences already exist in immutable `ValueEvent`s.

Synchronization may author receiver-local structural/freshness normalization events defined by the Journal 3 sync rules, but it must never create a new `ComputedValue` by executing application computation.

## History transfer

Imported records retain their original identities and bodies.

Receiving:

```text
B:73 ValueEvent(...)
```

means retaining that same B-authored record.

Receipt alone does not create an A-authored adoption/acknowledgement event.

A receiver may relay B:73 later without changing its author identity.

Conflicting bodies under B:73 indicate a writer fork/corruption, not an ordinary graph value conflict.

## Same-writer recovery

If the source contains a longer exact prefix of the receiver's own writer stream, synchronization may recover/import that suffix while under exclusive maintenance.

After recovery, local writer sequence, local allocation watermark, authority high-water, and other derived writer allocator state are reconstructed from the recovered history before any new receiver-authored normalization record is allocated.

If overlapping same-writer records disagree, synchronization fails.

This prefix-recovery case is not a second merge algorithm; it is ordinary immutable history union under the one-writer-stream invariant.

## Graph conflict semantics

Graph conflicts are resolved by Journal 3 replay over retained history.

Value/delete head selection uses the causality-respecting authority order from `incremental-graph-journal-types.md`.

Equal payloads remain distinct value occurrences unless they are the same `ValueId`.

Validation, invalidation, freshness, and validity are replayed from historical certificates/invalidation events rather than merged from legacy booleans/arrays.

A historical validation basis names its semantic inputs explicitly and is stored in canonical NodeKey order. Current replay accepts it as current proof only when its explicit input-key set matches the current direct-input set.

## Synchronization normalization

History union can reveal receiver-side semantic transitions which were never authored on the source because the source did not materialize the same dependent set.

Journal 3 therefore defines two explicit normalization families:

1. **dependency-closure deletion** — when a selected cached node has a missing selected input, the receiver authors causally later `DeleteEvent(reason="sync")` records over the required structural dependent closure;
2. **persistent fresh-to-stale propagation** — when synchronization keeps a receiver's current ValueId but changes that cached node from fresh to stale, the receiver authors a value-scoped `InvalidateEvent(reason="sync")` unless the final history already contains an uncovered current invalidation which persistently represents the transition.

These events are genuine receiver-authored history. They are not acknowledgement records and are not retroactively withdrawn if later unseen concurrent history changes the selected graph state.

Detailed detection/order/termination rules are normative in `incremental-graph-journal-sync.md`.

## Inactive target construction

Synchronization may take substantial time and may stream many records.

It therefore uses isolated target/staging state while ordinary graph activity continues to refer only to the old active supported database, subject to the lifecycle's exclusive maintenance rules during replacement/cutover.

Conceptually:

```text
old active state
    + stable source snapshot
        -> staged journal union
        -> local normalization records
        -> replayed target graph
        -> validation
        -> atomic cutover
```

Intermediate incomplete history/projection is never exposed as the active supported graph.

## Atomic publication

Successful synchronization publishes exactly one matching pair:

```text
(targetJournal, project(targetJournal))
```

No active state may expose imported history without its projection consequences or projection consequences whose records are not durably retained.

Failure before cutover leaves the previous active supported state selected, apart from disposable staging data.

An outer multi-source synchronization may commit sources one at a time. Therefore aggregate failure may coexist with prior successfully committed source synchronizations.

## Physical identifiers and writer allocation

The selected current `ValueEvent` supplies its exact physical `NodeIdentifier`.

Synchronization does not mint an arbitrary replacement merely because another replica allocated a different identifier for the same semantic NodeKey.

The conflict is resolved at value-occurrence authority; the winning occurrence's identifier becomes the selected identifier in the materialized projection.

The receiver-local `last_node_index` remains local writer state reconstructed from receiver-writer `WriterStateRecord`s. Foreign writer watermarks do not advance it.

## Freshness and validity

Synchronization does not textually merge `freshness`/`valid`.

Replay derives them from:

- selected current ValueIds;
- one selected validation certificate;
- the certificate's explicit semantic input-key set;
- exact basis ValueId matches;
- uncovered node/value invalidations;
- current direct-input freshness;
- sync-authored persistent stale events where required.

The final legacy sublevels are merely the frozen storage encoding of the replay result.

## Timestamps

The selected current `ValueEvent` supplies exact historical `createdAt` and `modifiedAt`.

Synchronization does not combine timestamp bytes from unrelated occurrences or manufacture a merge timestamp for the legacy graph.

`AuthorityTime` is separate conflict metadata. It may be causally advanced beyond `modifiedAt` without changing the historical legacy timestamp.

## Streamability and performance

Missing writer suffixes must be streamable without materializing the entire journal or suffix in RAM.

Target construction may use durable staging and derived indexes.

Journal 3 currently imposes no end-to-end change-sensitive running-time theorem; issue #1607 owns that future performance contract.

## Delayed replicas

Correctness does not depend on every replica participating, acknowledging history, or returning.

A delayed supported replica may later obtain the immutable writer suffixes it missed.

Authoritative journal records are not destructively reclaimed merely because currently active replicas appear to have passed them.

## Convergence

Compatible immutable writer-prefix union is idempotent, commutative, and associative at the retained-information level.

Replay of one fixed retained history is deterministic.

Synchronization normalization is real semantic authoring rather than a temporary merge annotation. Therefore Journal 3 does not claim that two counterfactual executions which process sources in different orders and consequently author different normalization records must end with identical histories or projections.

The required convergence property is per actual supported execution: once ordinary graph changes, reset, migration, and other non-normalization graph-changing operations stop, only finitely many synchronization `DeleteEvent`/value-scoped `InvalidateEvent` repairs can still be required. Under fair dissemination those repairs eventually stop, all actually authored records become shared, all replicas reach observably equivalent projections, and further synchronization becomes a semantic no-op.

The finite-normalization proof is normative in `incremental-graph-journal-sync.md` and `incremental-graph-journal-theorems.md`.

## Reset and migration

Controlled reset is specified by `incremental-graph-journal-reset.md`.

It retains history and appends a causally later receiver baseline whose projection matches the chosen source target.

Initial Journal 3 bootstrap and later version/schema migration are specified by `incremental-graph-journal-migrations.md`.

They record replay-complete target state; future replay does not rerun old migration callbacks.

Ordinary synchronization does not cross a database/schema version mismatch. Both sides must first reach a compatible current interpretation through the supported migration lifecycle.
