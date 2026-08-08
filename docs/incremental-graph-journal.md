# IncrementalGraph journal

The IncrementalGraph journal is immutable logical history and possible-change
notification infrastructure. It is not authoritative graph state. The graph
continues to own current values, freshness, wall-clock timestamps, identifiers,
and validity; synchronization consults journal history only to derive ordering
and causal barriers.

## Model

```text
JournalEntry = {
  author: HostFingerprint,
  sequence: uint64,
  key: NodeKey,
  action: "add" | "edit" | "delete" | "invalidate" | "validate",
  time: UnixTimestamp
}
JournalEntryId = (sequence, author)
```

IDs order sequence first, author second. Each durable host owns one persistent
`localJournalClock`, serialized by a dedicated allocator mutex. It raises its
watermark after observing remote entries and increments before authoring; IDs
are never reused and overflow is fatal. This is journal infrastructure, not a
materialization field or per-node clock.

The exact actions are absent→materialized add, unequal materialized value edit,
materialized→absent delete, fresh→stale invalidate, and stale→fresh validate.
There is no generic change. Graph mutation and its local entries commit
atomically.

## Merge and delivery

```text
J1 ⊔ J2 = compact(entries(J1) ∪ entries(J2))
```

A later entry covers an earlier one only for the same author, key, and action.
The non-covered canonical journal merge is commutative, associative, and
idempotent. Its bound is `O(historic keys × writers × 5)`, excluding local cursor
infrastructure.

Logical identity and local delivery are separate. Import preserves the remote
entry's author and sequence. The receiver may assign a fresh opaque local cursor
position so `possibleMaybeChanges()` exposes newly learned history, but never
re-authors the entry merely because it learned it. Compaction retains exact
action-specific possible-change coverage.

## Synchronization projections

For a materialized x, its current author-specific add/edit head must match its
real graph `modifiedAt`. The greatest surviving candidate by `(author,sequence)`
defines:

```text
ValueRevision(x) = [modifiedAt(x), author, sequence]
presenceHead(x)  = greatest add/delete by JournalEntryId
freshnessHead(x) = greatest invalidate/validate after the current add generation
```

These values are derived, never stored on graph materializations. A superseded
or unresolvable value is unusable. Delete prevents older add history from
resurrecting; invalidate prevents older fresh proof from resurrecting. A later
normal add or coherent validate, authored after observing its barrier, may begin
new positive history.

Presence resolves before value selection. When the joined presence head is an
add, only materializations whose source journal has that exact add as its
presence generation may compete by `ValueRevision`. A current-generation
invalidate makes the node stale and revokes all incoming validity proofs during
synchronization.

Synchronization invokes no computor. Copying a value imports its original
add/edit entry and emits no semantic value revision. Synchronization may derive
a conservative delete or invalidate; it authors that fact after all history
which caused it and does not repeatedly re-author a known barrier.

Detailed normative requirements and proofs are split into:

- [types](specs/incremental-graph-journal-types.md)
- [API](specs/incremental-graph-journal-api.md)
- [emission](specs/incremental-graph-journal-emission.md)
- [compaction](specs/incremental-graph-journal-compaction.md)
- [journal synchronization](specs/incremental-graph-journal-sync.md)
- [graph synchronization](specs/incremental-graph-synchronization.md)
