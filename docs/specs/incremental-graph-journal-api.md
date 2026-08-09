# Possible-change journal API

```text
graph.possibleMaybeChanges({ since, to })
baselinePossibleNodeChange()
PossibleNodeChange { nodeName, bindings, action, time }
```

A result means that this exact closed-classifier action may have happened to the
semantic key after the cursor. False positives and collapse into a later
covering possibility are allowed; action-specific false negatives are forbidden.

## Cursor and query

`since` is an opaque same-process cursor conceptually
`(localIndex,actionOrdinal)`, where the ordinal uses the fixed order add, edit,
delete, invalidate, validate. It is neither a `JournalEntryId` nor serializable
or user-constructible. The baseline is before every pair.

This cursor coordinate is `StoredJournalEntry.localIndex`, allocated from the
receiver's `localJournalIndexWatermark`; it is not the replicated
`JournalEntry.sequence` allocated from `localJournalClock`. Sequence travels
with immutable logical history, whereas local index never leaves its receiver
and may move when that receiver touches the entry.

A query retains one fixed committed active snapshot, captures
`localJournalIndexWatermark=H`, considers stored entries after `since` and at or
before H, expands them, applies `NodeFilter`, and returns deterministic
`(localIndex,actionOrdinal)` order. An implementation may scan the current physical journal; any secondary local index must be reconstructible. Because compaction is optional, cost may depend on uncompacted size.
Cutover cannot straddle snapshot selection.

For every qualifying stored entry E:

```text
PossibleActions(E) = { add, edit, delete, invalidate, validate }
PossibleNodeChange.time = E.entry.time
```

All five records use E's semantic key and immutable logical time. The local
index answers when this possibility became relevant to this receiver; `time`
answers when the underlying logical event occurred. There is no receiver-local
event object, action mask, cause field, or transition timestamp.

The action ordinal lets a client advance record-by-record without skipping the
remaining projections at one index:

```text
(51,add), (51,edit), (51,delete), (51,invalidate), (51,validate), (52,add)
```

## Installation and touch traces

* **Unknown history:** B first learns remote entry E. B stores E unchanged and
  assigns a fresh local index; all five possibilities become observable.
* **Known witness touched:** synchronization changes key K using history already
  known by B. B updates only `notificationWitness(K).localIndex`; its logical
  entry remains identical and all five possibilities cover the actual action.
* **Settled no-op:** receiving an already-known entry with no graph or compaction
  change neither touches it nor advances the watermark.

## Cursor-coverage theorem

For every successful transaction T and key K with at least one actual closed-
classifier transition, either T installs/authors an unknown entry for K or it
touches the greatest retained `JournalEntryId` for K,
`notificationWitness(K)`. Do this once per changed key, not once per action. If
an entry for K already receives a fresh index in T, no extra touch is needed.
Graph changes and index updates commit atomically.

For any cursor C issued before T:

```text
C <= oldWatermark < witness.localIndex
```

A later query therefore observes the witness, whose five projections include
the exact action. A later touch only moves coverage forward. If compaction
removes the witness, compaction touches another retained same-key witness above
its old watermark. Induction over transactions proves no action-specific false
negative. Touching one entry a million times retains one logical entry and one
scalar index.

Inactive construction copies every retained local index and the watermark from
one fixed receiver snapshot before allocating above it. Thus same-process cursors
remain comparable across cutover; remote indexes never participate.

## Deliberate cursor limitations

Computor invocation does not receive a journal cursor, and the runtime exposes no computation-position or bootstrap cursor. This omission is deliberate. `baselinePossibleNodeChange()` means only before all locally observable history in this cursor domain; it is not the position at which a computor began and is not a substitute. No raw `JournalIndex`, `journalGet`, computor context, hidden graph handle, or bootstrap cursor is part of this API.

A filtered query that scans through internal watermark H but returns no matching change produces no reusable cursor. The caller's previous cursor remains its only continuation and later queries may reconsider the same excluded entries. This is intentional. `possibleMaybeChanges()` guarantees conservative change coverage, not amortized filtered scan progress. No `scannedThrough` value and no `O(number of newly unseen matching changes)` guarantee is promised. Reconstructible indexes MAY optimize this without changing cursor semantics. Query cost may depend on uncompacted journal size.
