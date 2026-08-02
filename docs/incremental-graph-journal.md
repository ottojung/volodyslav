# IncrementalGraph Journal Overview

## Purpose

The IncrementalGraph journal records graph changes so that later computations, synchronization, migrations, and maintenance procedures can reason about what parts of the graph may need attention.

The journal is primarily exposed through a change-query operation:

```js
graph.possibleMaybeChanges({
    since,
    to,
}): Promise<Array<PossibleNodeChange>>
```

A caller provides a `PossibleNodeChange | BaselinePossibleNodeChange` as a cursor-like reference point and a `NodeFilter` describing the portion of the graph it cares about. The result is a finite array of later possible changes relevant to that filter, ordered by ascending journal index.

The method takes its arguments as a single object parameter with `since` and `to` fields.

This overview describes the role of the journal in the system. Detailed behavior is specified by the dedicated journal specification documents.

## Conceptual model

The journal is a graph-level change record. It lets code ask questions of the following form:

> Since this previously observed change, which matching nodes may have changed?

The answer is expressed as `PossibleNodeChange` values. A `PossibleNodeChange` is the public unit of journal observation and can be passed as `since` to a later `graph.possibleMaybeChanges` call in the same API context.

The journal specifies only same-process, in-memory token usage. A
`PossibleNodeChange` returned during a process session is valid as `since` for
subsequent calls within that same session. Within the same process, a cursor
remains valid across compaction (the private index survives physical deletion
of its backing entry), across normal pairwise synchronization and its
associated active-replica cutover (notification coverage reports changes
through repositioned canonical events), and across reset (an ordinary bulk
graph operation that preserves the cursor domain and keeps existing tokens
valid). A successful migration cutover may rotate the domain and reject tokens
registered in the old domain.
Persistence of these tokens across process restarts, synchronization boundaries
involving heterogeneous hosts, or migration/schema boundaries, and the
corresponding long-lived validity guarantees, are outside this journal's token
contract.

The journal is designed for incremental graph maintenance. A caller can pass a previously observed `PossibleNodeChange` as the `since` argument, or use `baselinePossibleNodeChange()` (a position less than any real journal index) to start from the beginning of the journal.

The detailed public meaning of `PossibleNodeChange` and `possibleMaybeChanges` is specified in:

```text
docs/specs/incremental-graph-journal-api.md
```

## Querying possible changes

The main query interface is:

```js
graph.possibleMaybeChanges({ since, to }): Promise<Array<PossibleNodeChange>>
```

The operation computes the logical journal view through a fixed upper bound `H`, restricts to entries strictly after `since`, applies the `to` filter, and returns the result in ascending index order. The `since` argument accepts `PossibleNodeChange | BaselinePossibleNodeChange`; `baselinePossibleNodeChange()` returns a position less than any real journal index.

The detailed scan order, initial value behavior, filtering behavior, and result semantics are specified in:

```text
docs/specs/incremental-graph-journal-api.md
```

## Node filters

Journal queries are restricted by `NodeFilter`.

A `NodeFilter` describes a set of node keys. It allows a journal consumer to ask only about changes to the part of the graph it depends on.

The filter system is an object API rather than a string language. Filters are
immutable: `makeWildcard()` returns a frozen singleton, `makeGroundFilter`
snapshots its argument array and nested `ConstValue` data, and
`makeUnionFilter` builds an immutable union. An asynchronous
`possibleMaybeChanges` call therefore observes one stable filter value for its
complete execution.

Construction, matching, wildcard behavior, composition, immutability, and
equality of filters are specified in:

```text
docs/specs/incremental-graph-node-filter.md
```

## Journal entries and change representation

The journal stores graph changes in a structured form. Public consumers observe changes through `PossibleNodeChange`.

The journal defines a **logical compaction projection** — the semantically significant view of journal entries through a fixed watermark. For each semantic node key, at most two entries are retained: the latest state/lifecycle entry (`add`, `edit`, or `delete`) and the latest freshness entry (`invalidate` or `validate`).

`possibleMaybeChanges` exposes this logically compacted view: latest state entry and latest freshness entry per matching semantic key, with cursor and filter applied afterward.

The exact representation of journal entries, timestamps, node keys, node identifiers, creator information, the logical journal view, and index/cursor behavior is specified in:

```text
docs/specs/incremental-graph-journal-types.md
```

## Journal emission

Journal entries are produced by ordinary graph, migration, and synchronization
operations under the emission rules. `validate` is originated by successful
recomputation of an already materialized node from `potentially-outdated` to
`up-to-date`. Synchronization may originate sync-derived `invalidate` and
`delete` events under the symmetric predicates in the synchronization
specification; it repositions existing canonical events when cursor notification
is required and no sync-derived event was originated.

Journal notification is conservative: coverage has no false negatives for
supported graph changes, but the journal may contain conservative or duplicate
notifications, and a returned action does not assert current graph state.

The journal emission rules define which IncrementalGraph operations create
journal changes and how those changes are coordinated with graph storage
updates. These rules cover recomputation, unchanged results, freshness
invalidation (`invalidate`), freshness restoration (`validate`), creation,
deletion, and migration actions.

The detailed emission behavior is specified in:

```text
docs/specs/incremental-graph-journal-emission.md
```

## Synchronization

Synchronization works by reading two exact logical snapshots, constructing the
complete merged database in an inactive replica, and switching the
active-replica pointer only after the inactive replica is complete and durable.
This is the existing replica-switching architecture; no database-state
abstraction beyond the replicas that already exist in the IncrementalGraph
design is introduced. The mechanism used to store or exchange snapshots is a
transport-adapter concern and never enters the IncrementalGraph semantics (see
`docs/specs/incremental-graph-journal-types.md` § Transport boundary).

Each logical snapshot carries a `SourceSnapshotProvenance` that includes a
causal frontier: for every hostname that contributed to the snapshot, the
latest host-state coordinate already incorporated — the pair of the immutable
storage-instance identity and the host's transport-independent logical state
version. A newly initialized storage instance starts with its own coordinate
(its instance and initial version `0`) in the frontier; a merge unions the two
frontiers (retaining the later coordinate for a hostname present in both within
the same instance, and rejecting a different `HostInstanceId` for the same
hostname as an administrative conflict); an export after ordinary activity
preserves remote entries and updates only the local hostname's coordinate,
advancing it exactly once per host-originated durable transaction and never for
synchronization-only activity.

The complete graph-and-journal merge is a canonical logical join over a
persisted, merge-closed basis: it is commutative, associative, and idempotent,
so the result is determined by the represented host-originated logical states
and not by the grouping or order in which snapshots were merged (see
`incremental-graph-synchronization.md` § 1b Logical join and § 1c Merge basis).
A derived replica persists the merge basis, so a later join is executable
without the original input replicas.

`HostInstanceId` is the immutable identity of one storage instance: it scopes
ordinary host-event identity, appears in every host state coordinate in the
frontier, and is unchanged by reset, migration, synchronization, compaction,
and replica cutover. A different instance for the same hostname is unrelated
reinitialization and an explicit administrative conflict.

Because the frontier records the exact logical state already incorporated,
synchronization is a fixed point for unchanged hosts: if the local frontier
dominates the staged frontier (for every hostname in the staged frontier, an
equal-or-later accepted coordinate), the per-host merge is a complete no-op.
Let `D = merge(A, B)`; if a staged snapshot's frontier is dominated by `D`'s
frontier, then `merge(D, S) = D` — no event is appended or repositioned, the
watermark is unchanged, no new provenance is published, consumers are not
notified again, and the active replica is not switched. Ordinary local graph
activity preserves remote frontier entries, so it does not make an unchanged
remote host "new"; only a later logical version within the same storage
instance does. An older staged coordinate within the same storage instance is
an ordinary dominated no-op (harmless replay); only a coordinate whose
`HostInstanceId` differs for the same hostname is rejected as an administrative
conflict rather than guessed.

Journal reconciliation is commutative and associative: reversing the two
source snapshots, or re-grouping the same host contributions, produces the
same journal result, the same exact logical state and `LogicalSnapshotId`, the
same causal frontier, and the same graph and journal merge bases.
Synchronization may originate
sync-derived `invalidate` and `delete` events as canonical projections of the
persisted journal basis under symmetric predicates (see
`docs/specs/incremental-graph-journal-sync.md`). For other graph changes
requiring notification, synchronization may copy, reposition, or retain
existing source events. Existing events may be made absent by the
synchronization-normalization phase (same-index poisoning, established-absence
propagation, logical-view pruning, duplicate occurrence normalization, or
carrier repositioning), moved to a fresh position when their original position
cannot survive, deduplicated when the same logical event already survives
elsewhere, or removed when superseded according to the settled compaction or
freshness rules.

The journal synchronization model defines how existing journal histories are
compared, copied, repositioned, omitted, and physically compacted during sync.
It also defines how logical snapshot provenance (including the causal frontier
and merge basis), journal creators, and deterministic event identity and
timestamps participate in conflict resolution.

Reset is an ordinary bulk graph procedure: an outer adapter resolves a hostname
to a validated target graph projection, and IncrementalGraph applies it through
`replaceGraphState` as one host-originated bulk transaction. The journal has no
reset operation of its own: the ordinary emission matrix records the reset's
graph changes, the journal namespace is preserved (no watermark decrease, no
cursor rotation, existing cursors stay valid), and the `HostInstanceId` is
unchanged. See `incremental-graph-synchronization.md` § 17 and
`incremental-graph-journal-emission.md` § Bulk reset.

The detailed synchronization behavior is specified in:

```text
docs/specs/incremental-graph-journal-sync.md
```

## Migration interaction

Migrations can transform graph storage in ways that affect journal state.

Migration is append-only: it preserves all established journal entries and absences exactly. Migration may append `add`, `delete`, and conditional `invalidate` entries. A later ordinary pull may emit `validate`, but that is a graph operation after migration, not a migration emission. Migration must not delete, fill, replace, rewrite, or otherwise modify an already established journal position.

The interaction between migration storage actions and journal state is specified in:

```text
docs/specs/incremental-graph-journal-migrations.md
```

## Compaction and maintenance

The journal may require maintenance as it grows.

Compaction can remove journal entries to manage storage. Compaction only changes physical storage size. The public journal query already suppresses every entry that compaction is permitted to remove — both use the same `logicalJournalView` through the captured bound.

Journal queries tolerate sparse storage by skipping absent entries and never reconstructing deleted entries.

The rules for compaction, retained information, deleted entries, and maintenance safety are specified in:

```text
docs/specs/incremental-graph-journal-compaction.md
```

## Garden concurrency domain

`possibleMaybeChanges` operates under a shared/exclusive **garden** concurrency
domain, separate from the main dome. Readers (enterGarden) may proceed
concurrently with each other and with ordinary graph activity. Structural
operations (closeGarden) exclude readers.

Lock ordering depends on the operation:

- **Compaction:** `closeGarden → darkroom`
- **Structural synchronization and migration/cutover:**
  `holiday → closeGarden → darkroom`

The second sequence expresses lock ordering when darkroom is required; it does
not require darkroom to be held for the complete operation.

The detailed concurrency specification is in
`docs/specs/incremental-graph-locking-design.md`.

## Related specifications

The journal system is connected to several other IncrementalGraph specifications:

```text
docs/specs/incremental-graph.md
docs/specs/incremental-graph-volatile-consistency.md
docs/specs/incremental-graph-node-filter.md
docs/specs/incremental-graph-journal-types.md
docs/specs/incremental-graph-journal-api.md
docs/specs/incremental-graph-journal-emission.md
docs/specs/incremental-graph-journal-sync.md
docs/specs/incremental-graph-journal-migrations.md
docs/specs/incremental-graph-journal-compaction.md
docs/specs/incremental-graph-synchronization.md
docs/specs/incremental-graph-locking-design.md
```

Together, these documents define the role of the journal, its public API, its storage behavior, and its interactions with the rest of IncrementalGraph.

## Cross-document invariants

The specifications are constrained by two cross-document invariants. No
document may relax them or introduce a compatibility alias, dual encoding,
optional legacy field, or alternate protocol path that bypasses them.

**Invariant 1 — Grouping independence.** The same represented host
contributions produce, regardless of merge ordering or grouping:

```text
same host contributions
    -> same normalized graph basis
    -> same normalized journal basis
    -> same projected graph
    -> same canonical journal
    -> same LogicalSnapshotId
```

**Invariant 2 — Atomic publication.** One host-originated transaction produces
exactly one successor `HostStateVersion` and publishes every artifact in one
atomic batch:

```text
one host-originated transaction
    -> one successor HostStateVersion
    -> atomic graph basis + journal basis + graph + journal publication
```

A failed or interrupted transaction leaves all of the above unchanged.
