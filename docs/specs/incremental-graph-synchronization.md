# Specification for IncrementalGraph Synchronization

## Status and scope

For database versions using Journal 3, synchronization is journal replication followed by deterministic replay/projection.

The semantic protocol is defined by:

- `incremental-graph-journal.md`;
- `incremental-graph-journal-types.md`;
- `incremental-graph-journal-sync.md`;
- `incremental-graph-journal-replay.md`.

This document defines the surrounding IncrementalGraph lifecycle obligations: synchronization must not invoke computors, must preserve ordinary graph invariants, and must publish imported history and its materialized projection atomically.

The public `pull()` and `invalidate()` semantics remain defined by the ordinary IncrementalGraph specifications.

The concrete transport is not semantic authority. Git/rendered snapshots may remain an implementation transport during the Journal 3 work, while the long-term remote representation is the replayable journal history itself. A transport-specific lifecycle must not change the journal merge/replay result.

## Journal-first synchronization

A Journal 3 replica consists semantically of immutable per-writer journal prefixes plus derived materialized graph state.

Normal synchronization does not merge `values`, `freshness`, `timestamps`, `valid`, or `identifiers_keys_map` as independent authorities.

Instead it:

1. obtains immutable journal records missing from the receiver;
2. verifies overlapping record identity and writer-prefix integrity;
3. obtains any additional records required for causal closure;
4. forms the target retained journal by immutable prefix union;
5. authors only those receiver-local semantic normalization events which the Journal 3 synchronization rules genuinely require;
6. computes the deterministic Journal 3 replay projection;
7. lowers that projection into the unchanged legacy IncrementalGraph sublevels;
8. validates the target;
9. durably publishes the journal and graph projection together.

A receiver with no prior records follows the same algorithm starting from the zero frontier. Journal 3 therefore has no second semantic merge algorithm for a special “full synchronization” mode.

## Preconditions

Before a Journal 3 synchronization target may be committed:

- source and receiver journal record interpretations must be compatible;
- the graph/database versions and graph schema used to interpret the retained history must be compatible under the current Journal 3 version boundary;
- every retained writer stream must be a contiguous immutable prefix;
- overlapping `JournalRecordId`s must have identical canonical meaning;
- the resulting target history must be causally closed;
- same-writer ownership safety from `incremental-graph-journal-sync.md` must hold;
- every semantic event and payload required by replay must be present;
- the resulting selected semantic heads must be dependency-closed after any required normalization;
- final replay must satisfy all ordinary IncrementalGraph storage invariants.

Malformed or conflicting history is rejected rather than repaired using payload equality, transport ancestry, or local/source preference.

## Computor prohibition

Synchronization MUST NOT invoke computors.

All semantic value occurrences considered during synchronization come from retained immutable `ValueEvent`s. If synchronization must create a new semantic normalization fact, it may author the appropriate non-computation event such as an invalidation or delete according to the Journal 3 synchronization specification.

Synchronization must never create a new `ComputedValue` by executing application computation.

## Immutable history transfer

Foreign records are copied with their original identities and bodies.

For example, receiving:

```text
B:73 ValueEvent(...)
```

causes the receiver to retain that same B-authored event. Receipt alone does not create a receiver-local “adopt” event.

The receiver may later relay B:73 to another replica without changing its author identity.

If two sources claim different records under B:73, the writer history has forked or storage is corrupt. The conflict is not an ordinary graph conflict and must not be resolved by EventRef authority.

## Graph conflict semantics

Graph conflicts are resolved by deterministic Journal 3 replay over the retained semantic history.

Value/delete head authority uses the causality-respecting EventRef order defined by `incremental-graph-journal-types.md`. Concurrent equal-payload values remain distinct occurrences unless they are the same `ValueId`.

Validation, invalidation, freshness, and validity are derived from the complete retained history according to `incremental-graph-journal-replay.md`; synchronization does not merge legacy boolean flags or validity arrays directly.

Because the complete history is retained, conflict resolution may use exact historical evidence rather than inferring provenance from current mutable records.

## Dependency closure and normalization

Every supported committed IncrementalGraph projection is dependency-closed.

A raw immutable journal union can select a present value for K while selecting absence for one of K's required inputs. Such a raw union is not yet a publishable target.

Synchronization must normalize the target by authoring explicit causally-later semantic events required to restore supported graph invariants. Structural cache removal must be represented by Journal 3 history; it must not occur only as a silent difference in the legacy projection.

Any normalization rule must:

- preserve the ordinary `oldValue` contract;
- author only genuine semantic transitions;
- join/observe the history on which the transition depends before allocating its authority;
- preserve replay completeness;
- include a convergence/termination argument so repeated synchronization cannot create an infinite acknowledgement or repair loop.

The detailed normalization algorithm is owned by `incremental-graph-journal-sync.md` and later refinements of that specification.

## Inactive target construction

Synchronization may perform network reads and substantial replay work over time. It therefore continues to use the database lifecycle's isolated target/cutover model.

Conceptually:

```text
active receiver
    + imported journal suffixes
    + receiver-local normalization events
        -> inactive target journal
        -> deterministic replay projection
        -> target validation
        -> durable cutover
```

Ordinary graph operations must not observe a partially imported journal or a partially rebuilt projection.

The target may be constructed incrementally, streamed, checkpointed, or indexed internally provided its final observable state is equivalent to complete Journal 3 replay.

## Atomic publication

A successful synchronization which changes retained journal history or graph projection must publish a matching pair:

```text
(targetJournal, project(targetJournal))
```

No supported active state may expose imported events without their graph consequences, or graph consequences whose determining events are absent from retained history.

Failure before cutover leaves the previous active state authoritative. Failure after a completed cutover follows the ordinary database lifecycle's post-publication failure semantics.

## Physical NodeIdentifiers

`NodeIdentifier` is persisted physical identity, not conflict authority.

Journal 3 `ValueEvent`s retain the identifier belonging to each materialization occurrence so replay can reconstruct the selected legacy identifier map without consulting the old current graph as authority.

A selected value occurrence therefore supplies its replayed current identifier. Incompatible identifier reuse is journal corruption rather than a reason to mint an arbitrary replacement during synchronization.

The receiver's host-local allocation watermark remains local-writer state and is reconstructed from its own `WriterStateRecord`s; foreign writer allocation watermarks do not advance it.

## Freshness and validity

Synchronization never textually merges `freshness` or `valid` records.

The replay specification derives:

- the selected current value occurrence;
- the applicable validation certificate;
- exact incoming validity edges;
- explicit/node-scoped invalidation effects;
- value-scoped persistent stale effects;
- recursive freshness through the current dependency graph.

The final `freshness` and `valid` sublevels are merely the unchanged legacy encoding of that replay result.

## Timestamps

The selected current `ValueEvent` supplies its exact historical `createdAt` and `modifiedAt` values.

Synchronization must not manufacture a merge timestamp or combine timestamp bytes from unrelated value occurrences. A replayed value occurrence carries the same payload and timestamps on every replica retaining that occurrence.

HLC `authorityTime` is separate from legacy timestamps. It may be causally advanced beyond a value's `modifiedAt`; replay does not rewrite the historical `modifiedAt` to match the HLC.

## Streamability

Journal history and missing synchronization suffixes may be unbounded.

Synchronization must therefore permit ordered streaming of missing writer records rather than requiring the complete journal or complete suffix to reside in RAM at once.

This streamability requirement does not impose the future end-to-end incremental synchronization time bound. GitHub issue #1607 owns that performance contract.

## Transport publication boundary

A transport must expose only stable immutable published writer prefixes as synchronization input.

Conceptually, a writer W has a published head q such that records `W:1..q` are immutable and obtainable. A partially uploaded suffix beyond q is not yet a synchronization source.

A database-backed transport may implement this using an expected-head append; a Git-backed transport may obtain the same property through an immutable committed snapshot. The physical mechanism is outside Journal 3 semantics.

## Delayed replicas

Correctness must not depend on every replica participating, acknowledging a deletion, or eventually returning.

A delayed replica may return after an arbitrarily long interval and consume the immutable history it missed. Authoritative records are not destructively reclaimed merely because currently active replicas appear to have advanced beyond them.

## Convergence

For compatible immutable writer streams, history union is idempotent, commutative, and associative.

Journal 3 replay is deterministic for one causally closed final history.

Therefore, once graph-changing operations and any finite synchronization-authored normalization cease, fair dissemination of all retained journal records brings supported replicas to observably equivalent IncrementalGraph projections. Subsequent synchronization without new history is a semantic no-op.

Any future normalization rule that can author new events during synchronization must preserve this convergence target and prove that fair repeated synchronization reaches a fixed point.

## Reset and migration boundary

Controlled reset and cross-version/schema migration are not specified here.

They must be represented as replayable Journal 3 history rather than replacing authoritative history with an unexplained graph snapshot. A Journal-3-aware migration must record the resulting semantic facts so future replay does not need to execute historical application migration code.

Until those dedicated specifications are complete, Journal 3 core synchronization is defined only for histories interpreted under one exact compatible database version/schema boundary.
