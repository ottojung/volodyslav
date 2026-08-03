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
```
