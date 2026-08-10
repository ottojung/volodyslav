# IncrementalGraph journal

## Supported-state boundary

The journal protocol is specified for graph and journal states produced by
supported Volodyslav lifecycle transitions, using the definition of supported
and corrupted or unsupported state in
[`database-lifecycle.md`](specs/database-lifecycle.md#11-corruption-model).
Journal correctness, synchronization, compaction, convergence, freshness,
provenance, and cursor-coverage guarantees quantify only over those states and
over history deliveries and unions that can arise between them.

A journal state that requires violation of the authoring, lifecycle, locking,
clock, immutability, or causal-context invariants is therefore corrupted or
unsupported under that lifecycle definition. Unless a specification explicitly
says otherwise, the protocol does not guarantee its detection, rejection,
recovery, convergence, or preservation as forensic evidence. Implementations
MAY detect and reject such corruption defensively, but those checks are not the
semantic correctness contract, and compaction need not retain evidence solely
for later corruption diagnosis.

The IncrementalGraph journal is immutable logical history and possible-change
notification infrastructure. It is not authoritative graph state. The graph
continues to own current values, freshness, wall-clock timestamps, identifiers,
and validity; synchronization consults journal history only to derive ordering
and destructive presence frontiers plus observed-invalidation freshness barriers.

## Normative synchronization contract

This design guarantees stable journal-backed identity for semantic value
versions represented by retained add/edit history; deterministic resolution of
wall-timestamp collisions; presence generations and generation-scoped freshness
barriers; and coherence decisions from evidence in the reachable source
snapshots and retained history defined here. When that evidence is insufficient,
the specified conservative stale/delete rules apply.

Synchronization never invokes computors or invents a `ComputedValue`. Logical
journal merge is commutative, associative, and idempotent over supported
histories whose delivery is a supported protocol state. Reconciliation is
pairwise and decentralized, requires neither a leader nor all-to-all exchange,
and permits hosts to be unavailable for arbitrary periods subject to the host
lifecycle and directional-fairness assumptions. `possibleMaybeChanges()` has no
action-specific false negatives, and fully compacted journal storage is `O(nr²)` under the size model below; uncompacted history may grow with operation count.

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
ValidateJournalEntry = GenerationScopedJournalEntryBase & { action: "validate", clearsInvalidates: InvalidationContext }
InvalidationContext = Map<HostFingerprint, JournalEntryId>
JournalEntryId = (sequence, author)
```

`JournalEntry.time` is the real wall-clock occurrence time of every journal
event. For add/edit, the event is semantic creation/modification, so `time`
matches graph `modifiedAt`.

The generation-scoped variants name the exact same-key add which established
their materialization incarnation. Add and delete variants contain no generation
field. The entry shape is independent of whether ordinary mutation,
synchronization, migration, or controlled reset authored it.

IDs order sequence first, author second. Each durable host owns one persistent
`localJournalClock`, serialized by a dedicated allocator mutex. It raises its
watermark after observing remote entries and increments before authoring; IDs
are never reused and overflow is fatal. This is journal infrastructure, not a
materialization field or per-node clock.

For graph mutation and controlled reset, the exact value/presence actions are
absent→materialized add, unequal materialized value edit, materialized→absent
delete, fresh→stale invalidate, and stale→fresh validate. An equal present value
is silent and preserves timestamps. Normal synchronization copies existing
values and provenance instead of authoring add/edit. There is no generic change.
Graph mutation and its local entries commit atomically.

## Merge and receiver-local cursor position

```text
J1 ⊔ J2 = compact(entries(J1) ∪ entries(J2))
```

A later entry covers an earlier notification only for the same author, key, and
action. Canonical compaction retains coordinate maxima, exact winning-generation value witnesses, per-author invalidation frontiers and validation witnesses, causal-reference closure, and referenced adds. Validated same-author context monotonicity and future-union closure make merge commutative, associative, and idempotent. Its fully compacted bound is `O(nr²)`.

Each retained entry is stored once with one receiver-local `localIndex` in a private, unforgeable cursor domain.
Import preserves immutable contents and assigns a fresh index only when the
entry is unknown. Touching changes only that scalar index. It never duplicates
or re-authors the entry. `possibleMaybeChanges()` expands every qualifying entry
to all five conservative actions, and compaction touches a surviving same-key
witness when it removes cursor-visible history. This touch preserves cursor coverage without adding a logical record. The physical uncompacted journal has no operation-count-independent bound.

`JournalEntry.sequence` is allocated from `localJournalClock`, replicates
unchanged, and forms logical identity with `author`. `StoredJournalEntry.localIndex`
is allocated from the distinct `localJournalIndexWatermark`, never replicates,
and may move when that receiver touches an existing entry. Each authored event
has a replicated logical sequence coordinate and each stored entry has a
receiver-local notification position. The sequence coordinate comes from the
author's Lamport-style clock; concurrent authors may use the same numeric
sequence, and globally comparable identity is
`JournalEntryId=(sequence,author)`.

For this bound, `n` is the number of current or historic semantic keys represented by the compacted database/journal, and `r` is the number of distinct durable authors represented by compacted entries or retained causal-context references. The fixed finite schema bounds arity and maximum serialized `ConstValue` size is a fixed system constant, so `NodeKey` size is constant. Per key, `O(r)` retained validations may each carry `O(r)` context; other witnesses are no larger. Therefore `size(compact(J)) = O(nr²)`. A scalar local index do not alter it.

**This guarantee applies only to complete canonical compaction.** Ordinary mutations may append immutable entries, and no operation-count-independent bound is promised for an uncompacted physical journal. Compaction may run at any time, after any transaction, during maintenance or synchronization, repeatedly, or be skipped arbitrarily long. Correctness never depends on its timing.
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
contains only add G or edits explicitly scoped to G and its `time`
must match the real graph `modifiedAt`. Wall time orders values; sequence only disambiguates equal times. Value revisions compare `modifiedAt` first. Only when
multiple provenance events match that same timestamp does sequence-first
`JournalEntryId=(sequence,author)` select the canonical origin:

```text
ValueRevision(x,G) = [modifiedAt(x), author, sequence]
presenceHead(x)  = greatest add/delete by JournalEntryId
invalidateFrontier(x,G)[A] = greatest invalidate by A scoped to G
effectiveValidate(V,x,G) iff V alone covers every frontier invalidate by exact-or-later same-author causal reference
```

These values are derived, never stored on graph materializations. A superseded
or unresolvable value is invalid source state. Delete prevents lower-ordered add
history from resurrecting; an invalidate scoped to G prevents lower-ordered
fresh proof for G from resurrecting. A later normal add starts another
generation, while a coherent validate explicitly scoped to G may restore G's
freshness.

Presence resolves before value selection. When the joined presence head is an add, only materializations whose source journal has that exact add as its presence generation may compete by `ValueRevision`.

A materialization is hard-invalidated when it requires genuine later normal revalidation rather than cache-only reuse. No graph-writing path may newly establish or deliberately reassert that obligation without a generation-scoped causal invalidate allocated after its observed history, unless the same causal decision already installed such a barrier. This includes explicit `invalidate(K)` on an already-stale node, synchronization stale→stale proof removal, migration hardening, and lifecycle hardening of stale proofless caches. Settled hard-invalidated state with an outstanding retained barrier is merely carried, so synchronization does not author endlessly. Public transition classification remains fresh→stale; an internal barrier may conservatively project a false positive.

A validation is authored only by genuine normal stale→fresh revalidation, captures the exact transaction-visible frontier atomically, and clears barriers only when it individually covers all of them. Contexts never combine, an unseen or delayed invalidate remains outstanding, and old generations are isolated. Synchronization never authors validate and never lets journal evidence manufacture graph validity.

Same-author validation contexts are normatively componentwise nondecreasing and journals are rejected before merge if a later context forgets or moves a coordinate backward, or if any reference is absent, mismatched, or not sequence-earlier than its validation.

Synchronization invokes no computor. Copying a value imports its original add/edit entry and emits no semantic value revision. Synchronization may derive a conservative delete or invalidate and authors it after observed causal history without repeatedly re-authoring a known barrier.
Detailed normative requirements and proofs are split into:

- [types](specs/incremental-graph-journal-types.md)
- [API](specs/incremental-graph-journal-api.md)
- [emission](specs/incremental-graph-journal-emission.md)
- [compaction](specs/incremental-graph-journal-compaction.md)
- [journal synchronization](specs/incremental-graph-journal-sync.md)
- [graph synchronization](specs/incremental-graph-synchronization.md)

## Deliberate API boundaries

Computor invocation deliberately receives no journal or bootstrap cursor. `graph.baselinePossibleNodeChange()` means only before all locally observable history in its cursor domain, not the position at which computation began. No equivalent hidden handle is exposed.

A filtered query returning no matching changes exposes no scanned-through cursor. Its prior cursor remains the only continuation and later calls may rescan irrelevant uncompacted history. `possibleMaybeChanges()` promises conservative coverage, not amortized filtered progress.
