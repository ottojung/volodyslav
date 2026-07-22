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
of its backing entry) and across structural synchronization and cutover
(notification coverage reports changes through repositioned canonical events).
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

The filter system is an object API rather than a string language. Construction, matching, wildcard behavior, composition, and equality of filters are specified in:

```text
docs/specs/incremental-graph-node-filter.md
```

## Journal entries and change representation

The journal stores graph changes in a structured form. Public consumers observe changes through `PossibleNodeChange`.

The journal defines a **logical compaction projection** — the semantically significant view of journal entries through a fixed watermark. For each semantic node key, at most two entries are retained: the latest state/lifecycle entry (`add`, `edit`, or `delete`) and the latest freshness entry (`invalidate` or `validate`).

`possibleMaybeChanges` exposes this logically compacted view: latest state entry and latest freshness entry per matching semantic key, with cursor and filter applied afterward.

The exact representation of journal entries, timestamps, node keys, node identifiers, host information, the logical journal view, and index/cursor behavior is specified in:

```text
docs/specs/incremental-graph-journal-types.md
```

## Journal emission

Journal entries are produced by ordinary graph, migration, and synchronization
operations under the emission rules. `validate` records successful recomputation
of an already materialized node from `potentially-outdated` to `up-to-date`.
Synchronization may emit `invalidate` and `delete` for actual graph transitions;
it repositions existing canonical events when cursor notification is required
and no sync-originated event was emitted.

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

Synchronization works by reading the current active local replica and the fetched remote replica, constructing the complete merged database in an inactive local replica, and switching the active-replica pointer only after the inactive replica is complete and durable. This is the existing replica-switching architecture; no database-state abstraction beyond the replicas that already exist in the IncrementalGraph design is introduced.

Synchronization may originate exact `invalidate` and `delete` events for actual
local transitions (see `docs/specs/incremental-graph-journal-sync.md`). For other
graph changes requiring notification, synchronization may copy, reposition, or
retain existing truthful source events. Existing events may be made absent by
poisoning or absence propagation, moved to a fresh position when their original
position cannot survive, deduplicated when the same logical event already
survives elsewhere, or removed when superseded according to the settled
compaction or freshness rules.

The journal synchronization model defines how existing journal histories are
compared, copied, repositioned, omitted, and physically compacted during sync.
It also defines how timestamps and host identities participate in conflict
resolution.

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

`possibleMaybeChanges` operates under a separate shared/exclusive **garden** concurrency domain, not the graph activity mode lock or the darkroom lock.

The journal is a garden separate from the main dome. Many visitors may enter the garden concurrently. Ordinary append-only journal growth may continue while visitors are present. Structural work that removes, poisons, or compacts established journal positions requires closing the garden. New evidence is always appended at fresh positions.

Two scoped helpers are defined:

```
enterGarden(procedure)   — shared access for journal readers
closeGarden(procedure)   — exclusive access for structural maintenance
```

### `possibleMaybeChanges`

`possibleMaybeChanges({ since, to })` MUST call `enterGarden` to acquire shared garden access before selecting the active replica. The linearization point is the read of `last_journal_index = H` after entering the garden. At that point, structural changes are excluded by shared garden access, and every position at or below `H` is finalized with respect to ordinary append-only operations.

The returned array reflects the logically compacted journal through `H`: for each matching semantic node key, at most its latest state entry and its latest freshness entry, restricted to indices strictly greater than `since`, ordered by ascending `JournalIndex`, projected to `PossibleNodeChange`.

### Structural journal operations

Compaction and structural synchronization MUST call `closeGarden` to acquire
exclusive garden access. Compaction may overlap ordinary appends. Structural
synchronization is a holiday operation: it first acquires `holidayActivity`,
then `closeGarden`, builds the inactive destination, and acquires the destination
darkroom for final metadata and cutover before releasing locks in reverse order.

### Lifecycle exclusion

Migration and replica cutover close the garden because of replica lifecycle safety, not because migration structurally mutates journal history. Migration is append-only: it preserves all established journal entries and absences exactly and may only append fresh entries. It must not delete, fill, replace, or rewrite an already established journal position. Migration closes the garden so that `possibleMaybeChanges` does not traverse a replica while it is being replaced. Two guarantees apply: every emitted journal event is atomic with the graph and freshness mutation that caused it, and the complete inactive destination remains invisible until durable cutover.

### Replica cutover

A holiday closes both the dome and the garden. Migration, structural
synchronization, and replica cutover acquire `holidayActivity` (graph activity
exclusion) and then `closeGarden` (garden exclusion). This prevents ordinary
appends from overlapping these operations and prevents new journal readers from
selecting the old replica during cutover.

### Compatibility

`possibleMaybeChanges` does not block ordinary daytime/nighttime graph activity globally. Journal readers coexist with daytime activity, nighttime activity, and ordinary append-only journal growth.

The full concurrency specification is in `docs/specs/incremental-graph-journal-api.md` and `docs/specs/incremental-graph-locking-design.md`.

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
docs/specs/incremental-graph-locking-design.md
```

Together, these documents define the role of the journal, its public API, its storage behavior, and its interactions with the rest of IncrementalGraph.
