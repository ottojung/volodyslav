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

The physical journal is append-only except for compaction deleting explicitly
selected obsolete occurrences. Compaction never replaces the journal.

```text
1. acquire closeGarden
2. open one fixed committed read view of the active physical journal
3. capture compaction watermark H
4. inspect only physical indices <= H
5. calculate the exact immutable set deleteIndices
6. submit one LevelDB batch containing only:
       del(index)
   for every index in deleteIndices
7. do not put or rewrite any retained occurrence
8. do not clear any range or sublevel
9. do not write, recompute, or decrease lastLocalJournalIndex
10. release closeGarden
```

The read view may be a LevelDB snapshot or an equivalent fixed committed
iterator view. Compaction does not acquire `activeReplicaDarkroom`;
`closeGarden` protects physical readers while deletions occur, and it is not
writer exclusion.

Any operation reading the active physical journal while compaction may run is a
shared garden reader: `possibleMaybeChanges` and synchronization source capture
hold `enterGarden`, compaction holds `closeGarden`, and the two are mutually
exclusive over the same replica. Synchronization's fixed committed snapshot `S`
remains readable after its `enterGarden` is released, so compaction deleting
obsolete indices from the live replica never changes the view synchronization
copies (`incremental-graph-locking-design.md` § Compaction-source race traces).

### 2.1 Writer race proof

All journal writers append at fresh indices strictly greater than the highest
index previously allocated. Compaction inspects indices through `H` and
calculates:

```text
deleteIndices ⊆ { indices <= H }
```

A concurrent writer appends event `E` at a fresh index `e > H`. The compaction
batch contains only exact deletes selected before `E` existed:

```text
e ∉ deleteIndices
```

Therefore `E` survives regardless of ordering. Both cases:

```text
writer commits before compaction deletion batch:
    E exists at e > H
    delete batch does not mention e
    E survives

writer commits after compaction deletion batch:
    E appends normally after the deletions
    E survives
```

There is no whole-layout replacement and no trace where a committed append is
erased.

### 2.2 Physical deletion eligibility

Logical normalization and physical cursor history are distinct. The compactor
must retain at least one physical occurrence for every canonical logical event:

```text
canonical state event per key
applicable canonical freshness event per key
```

For duplicate occurrences of one canonical event:

```text
retain the greatest LocalJournalIndex
delete earlier duplicates
```

For occurrences of noncanonical logical events, deletion is safe only when
conservative cursor coverage remains:

```text
An occurrence at index d for semantic key K may be deleted when there is a
retained occurrence for K at some index r > d.
```

The later occurrence can have a different action or category, because the public
API reports conservative possible changes rather than exact historical
transitions. Every existing cursor satisfies one of:

```text
cursor < r:
    it can still observe the retained occurrence at r

cursor >= r:
    it has already crossed the covering notification boundary
```

When a noncanonical occurrence has no later retained occurrence for the same
key:

```text
either retain it
or append a carrier of the current canonical event at a fresh index,
then delete it during a later compaction pass
```

Carriers are never appended inside the same deletion-only compaction pass;
append and delete phases are conceptually separate, and carrier creation is an
ordinary preceding append operation.

The public guarantee is:

```text
Compaction preserves conservative no-false-negative notification coverage.
It need not preserve the exact historical list of returned actions.
```

Compaction never changes a logical event's `eventId`, payload, or logical
revision. It never changes which entries `normalizeJournal` selects. The
root-local allocation watermark is never decreased and never recomputed from
surviving entries; indices freed as deletes remain gaps, and the allocator
continues strictly above its highest-ever value.

---

## 3. Interaction with the public API

Compaction preserves the observable suffix semantics of
`possibleMaybeChanges`: every physical occurrence that was scanned before
compaction either remains (as a retained occurrence at a covering index) or was
an occurrence whose removal cannot create a false negative, because a later
retained occurrence for the same key still covers the cursor domain. Same-process
cursor tokens remain valid across compaction.

---

## 4. Invariant

```text
Compaction is canonical maximum selection, not evidence pruning.
Physical compaction deletes only exact physical indices proven redundant.
It never replaces or truncates the journal.
Concurrent appends are outside its delete set by construction.
```
