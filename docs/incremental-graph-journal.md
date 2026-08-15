# IncrementalGraph journal

## Implementation/rollout scope

These specifications define the supported lifecycle of a journal-enabled
IncrementalGraph implementation. They do not define the one-time software
rollout from an older implementation which predates the journal subsystem.

A database produced by an implementation that does not implement the journal
specification is not a supported reachable journal state merely because it was
valid under an earlier implementation. The implementation project introducing
the journal is responsible for establishing the required initial
journal-enabled persistent state before operating such a database under these
semantics. That deployment and upgrade mechanism is outside this specification;
it is not a journal synchronization or database-version migration transition.

## Supported-state boundary

The journal protocol is specified for graph and journal states produced by
supported lifecycle transitions of an implementation satisfying these
specifications, using the definition of supported
and corrupted or unsupported state in
[`database-lifecycle.md`](specs/database-lifecycle.md#11-corruption-model).
Journal correctness, synchronization, compaction, convergence, freshness,
provenance, and cursor-coverage guarantees quantify only over those states and
over history deliveries and unions that can arise between them.

Legacy implementation states are outside this specification's journal-state
universe. This classification does not call those databases operationally
corrupt: upgrading them into this universe is a deployment compatibility
concern outside the journal semantics.

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
  author: DatabaseFingerprint,
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
InvalidationContext = Map<DatabaseFingerprint, JournalEntryId>
JournalEntryId = (sequence, author)
JournalIndex = (appendSequence, appender)
JournalRecord = {
  index: JournalIndex,
  key: NodeKey,
  nodeName: NodeName,
  bindings: BindingEnvironment,
  time: UnixTimestamp
}
```

`JournalEntry.time` is the real wall-clock occurrence time of every journal
event. For add/edit, the event is semantic creation/modification, so `time`
equals `toUnixTimestamp(graph.modifiedAt)`. Delete, invalidate, and validate
use their actual occurrence instant and do not modify graph `modifiedAt`.

`DatabaseFingerprint` is the existing IncrementalGraph database allocation
fingerprint specified by
[`incremental-graph-fingerprint.md`](specs/incremental-graph-fingerprint.md).
Locally authored entries use the authoring database's own fingerprint, not the
fingerprint suffix of the affected node's selected `NodeIdentifier`.
`UnixTimestamp` uses a signed 64-bit integer count of milliseconds since the
Unix epoch as its persistent representation. Valid values are the subset for
which the project `DateTime` can represent the exact instant and round-trip the
exact millisecond. Graph `DateTime` values project through
`toUnixTimestamp(dt) = dt.toMillis()`; the inverse produces the same instant as
a UTC `DateTime`. A raw int64 outside that exact domain is malformed journal
state and MUST be rejected during load.

The generation-scoped variants name the exact same-key add which established
their materialization incarnation. Add and delete variants contain no generation
field. The entry shape is independent of whether ordinary mutation,
synchronization, migration, or controlled reset authored it.

IDs order sequence first, author second. Each durable host owns one persistent
`localJournalClock`, serialized by a dedicated allocator mutex. It raises its
watermark after observing remote entries and increments before authoring; IDs
are never reused and overflow is fatal. This is journal infrastructure, not a
materialization field or per-node clock.

Ordinary graph mutation uses absent→materialized add, unequal materialized value
edit, materialized→absent delete, fresh→stale invalidate, and stale→fresh
validate. Controlled reset differs only for an unequal present value: it authors
a fresh add generation above observed receiver history. An equal present value
is silent and preserves timestamps. Normal synchronization copies existing
values and provenance instead of authoring add/edit. There is no generic change.
Graph mutation and its local entries commit atomically.

## Logical merge and global notification order

Logical merge remains `compact(entries(J1) union entries(J2))`, with the existing
future-union closure, ACI proof, presence generations and causal semantics. The
logical compacted bound remains `O(nr²)`. Notification state is separate:
immutable `JournalRecord {index,key,nodeName,bindings,time}` values are globally ordered by
`JournalIndex=(appendSequence,appender)`, unioned and compacted to the greatest
record per semantic key. This notification semilattice is independently ACI.

A durable, independent `localJournalRecordClock` allocates append sequences after
dominating observed remote notification state. A monotone
`journalRecordHighWatermark` survives deletion, restart, migration and sync. A monotone `cursorCoverageFrontier` records which issuing-host snapshots are safe to interpret. Serialized cursors are canonical progress claims, not security capabilities. These notification coordinates never influence logical conflict
ordering. Fully compacted notifications are `O(n)`, coverage is `O(r)`, and the
combined compacted bound remains `O(nr²)`; uncompacted history has no
operation-count-independent bound.

A cursor is a durable opaque serialization of an immutable global position plus
issuer coverage metadata. Querying is read-only and expands each surviving
record to all five actions. Max-per-key notification compaction is pure deletion:
it never moves a cursor or high-watermark, and a deleted cursor position is an
ordinary gap. Cross-host tokens are accepted only after the target's coverage
frontier reaches their issuing snapshot.

Existing-live controlled reset is an external administrative intervention, not
a continuously running reconciliation protocol. All global convergence and
quiescent-fixed-point claims assume eventual reset quiescence (finite reset
churn): only finitely many existing-live controlled resets occur in the relevant
execution suffix, or equivalently after some point no new controlled reset is
invoked while the system is allowed to converge. Ordinary synchronization may
continue arbitrarily often afterward. Every supported reset remains
individually safe and atomic, completed-reset cursor guarantees remain intact,
and the same receiver resetting again from the exact already-incorporated source
without intervening relevant change is silent. After the last externally
invoked reset, repeated ordinary synchronization of unchanged supported hosts
reaches a fixed point and appends no notification records. Infinite alternating
reset churn is outside only that liveness premise, not the supported-state or
per-reset safety contract; restart, migration, and compaction safety are
unchanged.

## Synchronization projections

All participating hosts in a supported execution share a synchronized real wall
clock. For value-changing events E1 and E2, if E1 occurs before E2 in real time,
then `E1.time <= E2.time`. Finite timestamp resolution is allowed, so distinct
events may have equal timestamps. Wall time is the intended real-time order and the primary
coordinate inside `ValueRevision` ordering among candidates which remain
eligible at the relevant selection stage. It does not override presence,
canonical-event, coherence, or fallback rules. Its finite resolution permits
equal timestamps; journal identity resolves only those collisions. Cross-host
clock skew, clock rollback, or any condition that can invert real event order in
wall-clock timestamps is outside the supported execution model. Synchronization
correctness and value-selection guarantees do not apply to such executions;
implementations need not detect them, and Volodyslav does not detect, repair,
compensate for, or preserve causality across unsynchronized clocks.

For materialized x in winning add generation G, define
`modifiedAtUnix(x)=toUnixTimestamp(graph.timestamps[x].modifiedAt)`. Each author-specific value head
contains only add G or edits explicitly scoped to G and its `time`
must match `modifiedAtUnix(x)`. Wall time orders values; sequence only disambiguates equal times. Value revisions compare `modifiedAtUnix` first. Only when
multiple provenance events match that same timestamp does sequence-first
`JournalEntryId=(sequence,author)` select the canonical origin:

```text
origin(x,G) = canonicalEvent(x,G)
ValueRevision(x,G) = [modifiedAtUnix(x), origin(x,G).sequence, origin(x,G).author]
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

A `ValidateJournalEntry` may be authored by ordinary genuine stale→fresh graph
revalidation or by existing-live controlled reset when authoritative semantic
reconciliation changes the receiver from stale to fresh. Both capture the exact
transaction-visible receiver-local frontier, require coherent final graph
validity, allocate after every referenced invalidate, and commit atomically with
the fresh graph state. Contexts never combine, an unseen or delayed invalidate
remains outstanding, and old generations are isolated. Normal synchronization
never authors validate and never lets journal evidence manufacture graph
validity. Reset uses the ordinary validation action without an origin flag.

Supported authoring makes same-author/key/generation validation contexts
componentwise nondecreasing. A visible later context which forgets or moves a
coordinate backward is corrupted or unsupported history; an implementation MAY
reject it defensively while the evidence remains. Compaction need not retain
arbitrary forensic evidence solely to make every past monotonicity violation
detectable. This optional diagnosis is distinct from structural interpretation:
every retained context coordinate `A -> I` MUST resolve to an existing retained
invalidate I authored by A for the validation's exact key and generation, with
`I.sequence < V.sequence`. An absent or mismatched retained reference cannot be
interpreted and MUST be rejected.

Synchronization invokes no computor. Copying a value imports its original add/edit entry and emits no semantic value revision. Synchronization may derive a conservative delete or invalidate and authors it after observed causal history without repeatedly re-authoring a known barrier.
Detailed normative requirements and proofs are split into:

- [types](specs/incremental-graph-journal-types.md)
- [API](specs/incremental-graph-journal-api.md)
- [emission](specs/incremental-graph-journal-emission.md)
- [compaction](specs/incremental-graph-journal-compaction.md)
- [journal synchronization](specs/incremental-graph-journal-sync.md)
- [graph synchronization](specs/incremental-graph-synchronization.md)

## Deliberate API boundaries

Computor invocation deliberately receives no journal or bootstrap cursor. `graph.baselinePossibleNodeChange()` is the universal before-all notification position, not the position at which computation began. No equivalent hidden handle is exposed.

A filtered query returning no matching changes exposes no scanned-through cursor. Its prior cursor remains the only continuation and later calls may rescan irrelevant uncompacted history. `possibleMaybeChanges()` promises conservative coverage, not amortized filtered progress.
