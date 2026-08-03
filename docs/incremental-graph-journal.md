# Incremental Graph Journal — Overview

The journal is the single authoritative synchronization state of IncrementalGraph.
This document is a non-normative overview; every claim is defined normatively in
the documents listed under Related specifications.

## Purpose

IncrementalGraph keeps node values, freshness markers, timestamps, identifiers,
and validity relations in a database for efficient runtime access. These are a
rebuildable materialized cache. The only authoritative state is the canonical
set of immutable journal entries:

```text
canonical journal entries
    -> deterministic graph projection
    -> persisted runtime graph cache
```

## Logical events and physical occurrences

A **logical event** is one immutable `JournalEntry` identified by its `eventId`.
An **origin** `{ hostname, hostInstanceId, originIndex }` names the storage
instance and monotonic index that created the event, and `eventId` is the
canonical encoding of the origin. There is exactly one event-ID format and no
sync-event IDs.

A **physical occurrence** is one local journal position containing an event.
Synchronization may append duplicate occurrences (notification carriers) so that
local cursors observe graph changes. Logical synchronization operates on
logical events; the public cursor API operates on local physical occurrences.

## Entries and categories

Per semantic key there are two independent logical categories:

```text
state:          add | edit | delete
freshness/proof: invalidate | validate
```

A state entry carries the complete materialization assertion — value,
timestamps, identifier, stored freshness, and the exact input state events it
was valid against. A freshness entry names exactly one subject state event and
applies only while that event remains selected. State selection never consults
freshness entries, so a concurrent validation of an old state can never
overwrite a newer edit.

## Revisions

A Lamport-style `logicalRevision` is scoped to one key and category: a new state
entry receives `1 +` the selected state entry's revision; a new freshness entry
for a subject receives `1 +` the selected freshness entry's revision for that
subject. Concurrent hosts may produce equal revisions; `eventId` is the
deterministic tie-breaker. This is documented deterministic last-writer-wins.

## Normalization and join

```text
normalizeJournal(entries)      one state + one applicable freshness per key,
                               chosen by maximum (logicalRevision, eventId)

joinJournal(A, B) = normalizeJournal(events(A) ∪ events(B))
```

The join is commutative, associative, and idempotent by set union plus canonical
maximum selection. Commutation with future union makes logical compaction
(`normalizeJournal`) safe.

## Graph projection

```text
projectGraph(schema, normalizedJournal)
```

rebuilds the graph from journal assertions without invoking a computor. Keys
with a selected `add`/`edit` are candidate materializations; the greatest
dependency-closed subset is installed, and the rest are closure-suppressed (the
assertion remains in the journal, so a later re-materialization of the missing
input can restore them). Validity is rebuilt from exact input-event references;
freshness is derived in dependency order.

## Synchronization

Synchronization validates inputs, joins the normalized journal entries, projects
the final graph, compares it with the pre-sync local graph, and installs
atomically. It creates no new logical event. To notify local cursors it appends
duplicate occurrences of canonical events as physical carriers. Logical state
converges across hosts; physical indices and carrier positions are deliberately
host-local.

## Public API

```text
graph.possibleMaybeChanges({ since, to })
baselinePossibleNodeChange()
PossibleNodeChange { nodeName, bindings, action, time }
```

A returned change is a conservative possible-change notification; it does not
assert current graph state, so carrier copies are legitimate.

## Compaction

Logical compaction is `normalizeJournal`; physical compaction deletes duplicate
occurrences while retaining the greatest local occurrence of each canonical
event. No checkpoint, lease, frontier, or compaction summary exists.

## Related specifications

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
