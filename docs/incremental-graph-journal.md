# IncrementalGraph journal

The IncrementalGraph journal is immutable logical history and possible-change
notification infrastructure. It is not authoritative graph state. The graph
continues to own current values, freshness, wall-clock timestamps, identifiers,
and validity; synchronization consults journal history only to derive ordering
and destructive LWW frontiers.

## Model

```text
JournalEntry = {
  author: HostFingerprint,
  sequence: uint64,
  key: NodeKey,
  action: "add" | "edit" | "delete" | "invalidate" | "validate",
  time: UnixTimestamp,
  generation?: JournalEntryId // present iff action is edit/invalidate/validate
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

A later entry covers an earlier notification only for the same author, key, and
action. Canonical compaction retains coordinate maxima plus bounded value and
freshness authority witnesses for the winning add generation. Merge is
commutative, associative, and idempotent, and its bound is
`O(historic keys × writers × 5)` with a constant freshness factor, excluding
local cursor infrastructure.

Logical identity and local delivery are separate. Import preserves the remote
entry's author and sequence. The receiver may assign a fresh opaque local cursor
position so `possibleMaybeChanges()` exposes newly learned history, but never
re-authors the entry merely because it learned it. Compaction retains exact
action-specific possible-change coverage.

Receiver-local delivery is independently append-or-replaced. `DeliveryHead`
points to at most one retained `DeliveryByIndex` record per key/action; a new
delivery atomically removes the old record, inserts a self-contained record at a
never-reused index above the watermark, and updates the head. This bounds both
physical maps by `O(historic keys × 5)` and leaves harmless scan gaps.

## Synchronization projections

For materialized x in winning add generation G, each author-specific value head
contains only add G or edits explicitly scoped to G and must match the real
graph `modifiedAt`. The greatest surviving candidate by `JournalEntryId`,
`(sequence,author)`,
defines:

```text
ValueRevision(x,G) = [modifiedAt(x), author, sequence]
presenceHead(x)  = greatest add/delete by JournalEntryId
freshnessHead(x,G) = greatest invalidate/validate whose generation == G
```

These values are derived, never stored on graph materializations. A superseded
or unresolvable value is invalid source state. Delete prevents lower-ordered add
history from resurrecting; an invalidate scoped to G prevents lower-ordered
fresh proof for G from resurrecting. A later normal add starts another
generation, while a coherent validate explicitly scoped to G may restore G's
freshness.

Presence resolves before value selection. When the joined presence head is an
add, only materializations whose source journal has that exact add as its
presence generation may compete by `ValueRevision`. A current-generation
invalidate scoped to that generation makes the node stale and revokes all
incoming validity proofs during
synchronization.

Synchronization invokes no computor. Copying a value imports its original
add/edit entry and emits no semantic value revision. Synchronization may derive
a conservative delete or invalidate; it authors that fact after all history
which caused it and does not repeatedly re-author a known barrier.

Presence and freshness frontiers are deterministic Lamport/LWW registers, not
proofs of causal observation. A greater concurrent add may supersede a delete,
and a greater concurrent same-generation validate may supersede an invalidate.
A destructive entry is guaranteed to dominate the histories its author actually
observed because its sequence is allocated above them; previously unseen finite
positive history may cross it once and cause a later reconciliation decision.

Detailed normative requirements and proofs are split into:

- [types](specs/incremental-graph-journal-types.md)
- [API](specs/incremental-graph-journal-api.md)
- [emission](specs/incremental-graph-journal-emission.md)
- [compaction](specs/incremental-graph-journal-compaction.md)
- [journal synchronization](specs/incremental-graph-journal-sync.md)
- [graph synchronization](specs/incremental-graph-synchronization.md)
