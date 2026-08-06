# Incremental Graph Journal — Compaction

This document defines compaction as canonical normalization and
duplicate-occurrence deletion. No checkpoint, lease, frontier, or compaction
summary is needed for logical safety.

---

## 1. Logical compaction

Logical compaction is exactly `normalizeJournal` (`incremental-graph-journal-types.md`
§ Canonical journal normalization). It may permanently discard:

- non-winning state entries;
- freshness entries for non-selected states;
- non-winning freshness entries for the selected state.

This is safe because normalization commutes with future union
(PROP-JT-01): compacting a journal and then joining it with new entries
produces the same result as joining the uncompacted journal.

```text
normalize(normalize(A) ∪ B)
    =
normalize(A ∪ B)
```

No checkpoint transaction and no removed-entry tombstone exists. Compaction is
canonical maximum selection, not evidence pruning; there is no retained
evidence to prune.

---

## 2. Physical compaction

Physical compaction may additionally delete duplicate physical occurrences while
retaining:

```text
the greatest local physical occurrence of each canonical logical event
```

Because notification carriers are copies of canonical events, the retained
occurrence remains sufficient for every same-process cursor:

- a cursor before the retained occurrence sees it;
- a cursor after the retained occurrence has already crossed the relevant
  notification boundary.

Compaction never changes a logical event's `eventId`, payload, or logical
revision. It never changes which entries `normalizeJournal` selects. It only
changes the local physical layout.

### 2.1 Serialization with occurrence writers

Physical compaction of the active journal is serialized with both physical
readers AND occurrence writers. `closeGarden` protects readers but does not by
itself exclude host operations that append occurrences under the active-replica
darkroom. Compaction therefore uses both, in the one lock order:

```text
closeGarden -> activeReplicaDarkroom
```

```text
1. acquire closeGarden
2. acquire activeReplicaDarkroom
3. read one committed physical journal and watermark
4. calculate the compacted occurrence layout
5. write the complete replacement layout and unchanged-or-advanced watermark
   in one durable batch
6. release activeReplicaDarkroom
7. release closeGarden
```

No host-originated operation can finalize an append while steps 3-5 run: every
append finalizes under the same `activeReplicaDarkroom`, and it cannot hold that
darkroom and then request `closeGarden` (no path acquires a darkroom and then
`closeGarden`).

The root-local allocation watermark is never decreased and never recomputed
from surviving entries; a compacted layout may free indices as gaps, but the
allocator continues strictly above its highest-ever value.

### 2.2 Compaction race

```text
compaction starts
concurrent pull prepares event E
```

Exactly two serializations are allowed:

```text
E commits before compaction reads:
    E is included in compacted input

E commits after compaction releases the darkroom:
    E appends after the compacted layout
```

There is no execution in which E commits and is then erased by compaction.

---

## 3. Interaction with the public API

Compaction preserves the observable suffix semantics of
`possibleMaybeChanges`: every physical occurrence that was scanned before
compaction either remains (as the greatest retained occurrence of its event) or
was a duplicate whose removal cannot change the deduplicated, greatest-per-key
result. Same-process cursor tokens remain valid across compaction.

---

## 4. Invariant

```text
Compaction is canonical maximum selection, not evidence pruning.
Physical compaction is serialized with both readers and occurrence writers.
```
