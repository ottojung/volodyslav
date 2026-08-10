# IncrementalGraph journal emission

## Atomic local classification

A successful normal graph transaction compares its committed before and after
states and applies the closed classifier in the journal types specification.
Intermediate states do not emit. The graph mutation and every locally authored
entry commit atomically; a reachable committed snapshot never contains one
without the other.

Before authoring, reserve one sequence per entry from the dedicated host-local
journal-clock allocator. The allocator first observes the maximum sequence in
the transaction's installed journal, then increments. Multiple entries receive
distinct increasing sequences. Aborted reservations may leave gaps but are
never reused; overflow is fatal.

Every `JournalEntry.time` is the actual wall-clock occurrence time of its
journal event. Every add/edit also requires `valueModifiedAt`, equal to the
resulting graph materialization's exact `timestamps[key].modifiedAt` and used by
value provenance. Delete/invalidate/validate forbid `valueModifiedAt`. For an
ordinary semantic value-changing add/edit, one transition-time observation
normally supplies both equal values, but their meanings remain independent and
no rule relies on equality.

Before changing an already-materialized value, invalidating, or revalidating,
derive the materialization's exact establishing add ID G from the
pre-transaction graph/journal snapshot. An emitted edit, invalidate, or validate
MUST carry `generation=G`. If G cannot be resolved, the transaction is an
invariant violation and cannot commit. A newly materialized value emits add,
which itself establishes G and carries no generation. Delete also carries no
generation. `Unchanged` still emits no edit.

| Before | After | Entries |
|---|---|---|
| absent | materialized | `add` |
| value A | unequal value B | `edit` |
| value A | `Unchanged` value A | none |
| materialized | absent | `delete` |
| fresh | stale | `invalidate` |
| stale | fresh | `validate` |

For stale→fresh, the validate contains `clearsInvalidates`, the complete per-author invalidation frontier for its key/generation in the exact transaction-visible journal snapshot. Graph freshness and this immutable context commit atomically. A validate is forbidden on any other path.

Identifier-only, timestamp-only, and validity-edge-only changes emit nothing.

### Global hard-invalidation invariant

The public closed classifier remains unchanged: only fresh→stale is an
`invalidate` transition notification. Separately, a materialization is
**hard-invalidated** when it requires a later genuine normal recomputation or
revalidation before becoming fresh; in particular, its incoming proof set is
insufficient for cache-only reuse. No graph-writing operation may establish or
deliberately reassert that obligation without representing the causal decision
in the materialization generation's invalidation frontier.

Whenever a transaction newly establishes or deliberately reasserts hard
invalidation, it MUST author a generation-scoped `InvalidateJournalEntry` after
all history it observed, unless a barrier installed or authored by that same
causal decision already represents the exact new obligation. This rule depends
on the proof/revalidation obligation, not merely on a freshness transition. The
internal barrier may create a permitted conservative possible-change false
positive.

Every successful explicit public `invalidate(K)` on a materialized node removes
or reasserts absence of incoming validity proofs and therefore authors a new
barrier even when K was already stale. Synchronization and migration follow the
same invariant when they harden stale materializations. Equivalent lifecycle
paths MUST do likewise; there is no migration- or synchronization-specific
journal action.

The barrier carries the materialization's exact generation G. Its sequence is reserved from `localJournalClock` after observing the transaction snapshot and is greater than all history observed by the operation. Incoming-proof removal/reassertion, graph state, the immutable barrier, receiver-local index, and watermarks commit atomically in the same darkroom batch. Each repeated explicit hard invalidation authors a fresh barrier: each call independently reasserts that the next pull must invoke the computor. Invalidation propagated by ordinary dependency mechanics may preserve complete validity proofs and continues to author only on its actual fresh→stale transition; such freshness-only propagation does not newly establish hard invalidation.

## Synchronization emission

Synchronization invokes no computor and therefore cannot invent a semantic
`ComputedValue`. Copying or selecting an existing value imports its originating
`add`/`edit` history unchanged and MUST NOT author an `add` or `edit`. An unknown
import receives a receiver-local index on its single stored entry.

Synchronization can derive genuinely new conservative facts:

* deleting incompatible caches or a joined generation for which no valid source
  carries usable bytes; and
* invalidating a cache whose freshness proof cannot safely survive.

For a newly caused delete transition it authors `delete`. For fresh→stale
demotion or stale→stale proof removal which newly establishes hard invalidation,
it authors `invalidate` unless the same causal decision installed an exact
representing barrier. Each such sequence is greater than every entry observed by
that synchronization operation, and graph/proof state, joined journal, stored
entry/index, and watermarks are installed atomically. A settled obligation
already represented by an outstanding retained barrier is propagated, not
re-authored. Synchronization never synthesizes `validate`; only normal graph
revalidation with coherent validity evidence may do that.

A synchronization-authored invalidate sets `generation` to the final joined add
generation whose selected materialization it demotes. It cannot be emitted when
final presence is absent or the add generation is unresolved.

Logical emission and receiver-local cursor indexing are one stored-journal
operation. Every newly authored entry receives a distinct increasing
`localIndex` above the pre-transaction `localJournalIndexWatermark`. Every newly
installed remote entry does likewise while retaining immutable logical contents.
Receiving an already-known entry alone does nothing.

For synchronization, compute the compacted logical result and all graph
transitions first. For each changed semantic key K, a newly installed/authored
entry for K supplies fresh cursor coverage; otherwise touch the greatest retained
`notificationWitness(K)` exactly once. This includes every structurally deleted
or transitively invalidated dependent whose graph state changed. The graph,
logical entries, local-index changes, and both allocator watermarks commit
atomically.

Ordinary mutations author exact classifier entries. Several entries for one key
receive distinct local indexes, and no touch is needed unless some real
transition lacks a freshly indexed entry. `Unchanged` remains silent.

## Controlled-reset re-generation

Controlled reset is an administrative exception to mechanical application of
the ordinary classifier. After joining all receiver and source history, it
authors a fresh receiver `add` generation for every key that the desired target
materializes, even for a present-to-present or equal-value replacement. Each
such add is allocated after all history observed by reset. Every historic key
known to the joined graph/journal which the target wants absent receives a
receiver `delete` after the observed presence history.

Let R be reset's real wall-clock occurrence time. When the desired value
differs, reset sets `graph.modifiedAt=add.time=add.valueModifiedAt=R`. When the
values are semantically equal, reset preserves old semantic modification time M,
sets `graph.modifiedAt=add.valueModifiedAt=M`, and still sets `add.time=R`.
Fresh generation identity establishes presence; `valueModifiedAt` does not. In both cases the fresh add generation, rather
than wall-time comparison with older generations, makes pre-reset edits and
freshness events inapplicable.

A settled equivalent synchronization authors no entry, learns no entry, touches
nothing, changes no graph, and advances neither watermark.

## Reachability invariant

All correctness arguments use the
[journal supported-state boundary](incremental-graph-journal-types.md#supported-state-boundary)
and therefore range over snapshots reachable through atomic normal mutations,
migrations that preserve these invariants, and the synchronization protocol.
Arbitrary mismatched graph/journal pairs are corrupted or unsupported under the
definition in `database-lifecycle.md`, not ordinary conflicts. Defensive
validation MAY reject some such inputs, but complete detection is not a protocol
correctness obligation.
