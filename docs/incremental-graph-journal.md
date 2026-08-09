# IncrementalGraph journal

The IncrementalGraph journal is immutable logical history and possible-change
notification infrastructure. It is not authoritative graph state. The graph
continues to own current values, freshness, wall-clock timestamps, identifiers,
and validity; synchronization consults journal history only to derive ordering
and destructive LWW frontiers.

## Normative synchronization contract

This design guarantees stable journal-backed identity for semantic value
versions represented by retained add/edit history; deterministic resolution of
wall-timestamp collisions; presence generations and generation-scoped freshness
barriers; and coherence decisions from evidence in the reachable source
snapshots and retained history defined here. When that evidence is insufficient,
the specified conservative stale/delete rules apply.

Synchronization never invokes computors or invents a `ComputedValue`. Logical
journal merge is commutative, associative, and idempotent. Reconciliation is
pairwise and decentralized, requires neither a leader nor all-to-all exchange,
and permits hosts to be unavailable for arbitrary periods subject to the host
lifecycle and directional-fairness assumptions. `possibleMaybeChanges()` has no
action-specific false negatives, and journal storage is `O(nr)` under the size
model below.

The journal does not retain complete historical direct-input version provenance
for cached derived values. It is not guaranteed to reconstruct the exact vector
of input versions against which every retained historical derived value was
computed. Current `valid` edges and transient synchronization support represent
available snapshot evidence, not a complete computation history.

Consequently, insufficient evidence may make synchronization retain a cache
stale or delete it under the fallback rules. A multi-input cache may be deleted
even where additional historical provenance could have established that some
`oldValue` was safe. Maximal `oldValue` preservation and stronger historical
reconstruction are deliberately outside this contract; no such property is
implied.

## Model

```text
JournalEntry =
    AddJournalEntry
  | DeleteJournalEntry
  | EditJournalEntry
  | InvalidateJournalEntry
  | ValidateJournalEntry

JournalEntryBase = {
  author: HostFingerprint,
  sequence: uint64,
  key: NodeKey,
  time: UnixTimestamp
}
AddJournalEntry = JournalEntryBase & { action: "add" }
DeleteJournalEntry = JournalEntryBase & { action: "delete" }
GenerationScopedJournalEntryBase = JournalEntryBase & {
  generation: JournalEntryId
}
EditJournalEntry = GenerationScopedJournalEntryBase & { action: "edit" }
InvalidateJournalEntry = GenerationScopedJournalEntryBase & { action: "invalidate" }
ValidateJournalEntry = GenerationScopedJournalEntryBase & { action: "validate" }
JournalEntryId = (sequence, author)
```

The generation-scoped variants name the exact same-key add which established
their materialization incarnation. Add and delete variants contain no generation
field. The entry shape is independent of whether ordinary mutation,
synchronization, migration, or controlled reset authored it.

IDs order sequence first, author second. Each durable host owns one persistent
`localJournalClock`, serialized by a dedicated allocator mutex. It raises its
watermark after observing remote entries and increments before authoring; IDs
are never reused and overflow is fatal. This is journal infrastructure, not a
materialization field or per-node clock.

For ordinary graph mutation and synchronization, the exact actions are
absent→materialized add, unequal materialized value edit, materialized→absent
delete, fresh→stale invalidate, and stale→fresh validate. Controlled reset is
the sole administrative exception: it may author a fresh add for an already-
materialized target key to establish a new authoritative presence generation.
This does not broaden ordinary add or permit synchronization to author a
present→present add. There is no generic change. Graph mutation and its local
entries commit atomically.

## Merge and receiver-local cursor position

```text
J1 ⊔ J2 = compact(entries(J1) ∪ entries(J2))
```

A later entry covers an earlier notification only for the same author, key, and
action. Canonical compaction retains coordinate maxima plus bounded value and
freshness authority witnesses for the winning add generation. Merge is
commutative, associative, and idempotent, and its bound is
`O(nr)` with a constant action/witness factor.

Each retained entry is stored once with one receiver-local `localIndex`.
Import preserves immutable contents and assigns a fresh index only when the
entry is unknown. Touching changes only that scalar index. It never duplicates
or re-authors the entry. `possibleMaybeChanges()` expands every qualifying entry
to all five conservative actions, and compaction touches a surviving same-key
witness when it removes cursor-visible history. Total stored records remain
`O(nr)`.

`JournalEntry.sequence` is allocated from `localJournalClock`, replicates
unchanged, and forms logical identity with `author`. `StoredJournalEntry.localIndex`
is allocated from the distinct `localJournalIndexWatermark`, never replicates,
and may move when that receiver touches an existing entry. There is one logical
distributed event sequence and one receiver-local notification position.

For this bound, `n` is the number of current or historic semantic node keys
represented by the database/journal, and `r` is the number of distinct durable
journal authors represented by retained history. The five actions are a fixed
constant. There is no fixed closed writer-membership domain: a supported new
host may introduce another durable `HostFingerprint`, so storage is not bounded
independently of `r`. Each retained logical entry has one local index, and
touching does not add records.

The fixed finite schema bounds node arity. Complexity analysis also treats the
maximum serialized size of one `ConstValue` as a fixed system constant, so a
`NodeKey`, including its bounded-arity bindings, contributes only a constant
factor. The bound is therefore `O(nr)`, without a value-size or binding-depth
dimension. Journal entries contain no `ComputedValue` or historical support
vector.

## Synchronization projections

Supported hosts have monotone system wall clocks. Wall time is the best
available approximation of universal cross-host event order. It is the primary
coordinate inside `ValueRevision` ordering among candidates which remain
eligible at the relevant selection stage. It does not override presence,
canonical-event, coherence, or fallback rules. Its finite resolution permits
equal timestamps; journal identity resolves only those collisions. Clock
rollback violates the supported execution model and has undefined
synchronization behavior.

For materialized x in winning add generation G, each author-specific value head
contains only add G or edits explicitly scoped to G and must match the real
graph `modifiedAt`. Value revisions compare `modifiedAt` first. Only when
multiple provenance events match that same timestamp does sequence-first
`JournalEntryId=(sequence,author)` select the canonical origin:

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
