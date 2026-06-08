# IncrementalGraph Journal Overview

## Purpose

The IncrementalGraph journal records graph changes so that later computations, synchronization, migrations, and maintenance procedures can reason about what parts of the graph may need attention.

The journal is primarily exposed through a change-query operation:

```js
graph.possibleMaybeChanges({
    since,
    to,
}): AsyncIterator<PossibleNodeChange>
```

A caller provides a `PossibleNodeChange | BaselinePossibleNodeChange` as a cursor-like reference point and a `NodeFilter` describing the portion of the graph it cares about. The result is a stream of later possible changes relevant to that filter.

The method takes its arguments as a single object parameter with `since` and `to` fields.

This overview describes the role of the journal in the system. Detailed behavior is specified by the dedicated journal specification documents.

## Conceptual model

The journal is a graph-level change record. It lets code ask questions of the following form:

> Since this previously observed change, which matching nodes may have changed?

The answer is expressed as `PossibleNodeChange` values. A `PossibleNodeChange` is the public unit of journal observation. It can be inspected for its public change information and passed as `since` to a later `graph.possibleMaybeChanges` call in the same API context. Persistence and long-lived validity of such values are out of scope for this PR.

The journal is designed for incremental graph maintenance. A caller can pass a previously observed `PossibleNodeChange` as the `since` argument, or use `baselinePossibleNodeChange()` to start from before any journal entry. The journal returns later possible changes so callers can focus on affected nodes without rediscovering everything from scratch.

The detailed public meaning of `PossibleNodeChange` and `possibleMaybeChanges` is specified in:

```text
docs/specs/incremental-graph-journal-api.md
```

## Querying possible changes

The main query interface is:

```js
graph.possibleMaybeChanges({ since, to }): AsyncIterator<PossibleNodeChange>
```

The operation starts from the supplied `since` value and returns later possible changes matching the `to` filter. The `since` argument accepts `PossibleNodeChange | BaselinePossibleNodeChange`; calling `baselinePossibleNodeChange()` yields a sentinel that scans from before the first journal entry.

The detailed scan order, initial value behavior, cursor advancement, filtering behavior, and result semantics are specified in:

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

The journal stores graph changes in a structured form. Public consumers observe those changes through `PossibleNodeChange`.

The journal change model covers additions, edits, deletions, and changes produced by synchronization or migration. The exact representation of journal entries, timestamps, node keys, node identifiers, host information, and index/cursor behavior is specified in:

```text
docs/specs/incremental-graph-journal-types.md
```

## Journal emission

Journal entries are produced by graph operations that change the observable graph state.

The journal emission rules define which IncrementalGraph operations create journal changes and how those changes are coordinated with graph storage updates. These rules cover recomputation, unchanged results, invalidation, creation, deletion, migration actions, and synchronization-generated changes.

The detailed emission behavior is specified in:

```text
docs/specs/incremental-graph-journal-emission.md
```

## Synchronization

The journal participates in synchronization between hosts.

Synchronization must reconcile graph state and journal state together, so that graph-state reconciliation is visible through later journal queries. Sync may introduce journal changes that represent remote graph changes, conflict resolution, or reconciliation effects.

The journal synchronization model defines how journal histories are compared, merged, appended, deleted, or compacted during sync. It also defines how timestamps and host identities participate in conflict resolution.

The detailed synchronization behavior is specified in:

```text
docs/specs/incremental-graph-journal-sync.md
```

## Migration interaction

Migrations can transform graph storage in ways that affect journal state.

Some migration actions may preserve journal history. Some may create new journal changes. Others may remove or rewrite journal information associated with deleted or transformed nodes.

The interaction between migration storage actions and journal state is specified in:

```text
docs/specs/incremental-graph-journal-migrations.md
```

## Compaction and maintenance

The journal may require maintenance as it grows.

Compaction can remove journal data that is no longer needed for future operation, while preserving the behavior required by journal queries. Maintenance procedures may also normalize journal storage after synchronization or migration.

The rules for compaction, retained information, deleted entries, and maintenance safety are specified in:

```text
docs/specs/incremental-graph-journal-compaction.md
```

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
```

Together, these documents define the role of the journal, its public API, its storage behavior, and its interactions with the rest of IncrementalGraph.
