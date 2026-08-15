# IncrementalGraph journal emission

## Atomic local classification

A successful normal graph transaction compares its committed before and after
states and applies the closed classifier in the journal types specification.
Intermediate states do not emit. The graph mutation and every locally authored
entry commit atomically; a reachable committed snapshot never contains one
without the other.

Before authoring, tentatively choose one sequence per entry from the dedicated
host-local journal-clock allocator. The allocator first observes the maximum
sequence in the transaction's installed journal, then increments. Multiple
entries receive distinct increasing sequences. The entries and resulting
allocator value become durable atomically. Published sequences are never reused,
but a transaction that aborts before publication exposes no durable coordinate
or allocator advancement, so its tentative sequence MAY be chosen later.
Committed allocator progression MAY skip numbers and create harmless gaps.
Overflow is fatal and wrapping is forbidden.

Every `JournalEntry.time` is the actual wall-clock occurrence time of its
journal event. For add/edit the occurrence is semantic creation/modification, so
`entry.time == toUnixTimestamp(graph.timestamps[key].modifiedAt)` in the
committed state.
Delete/invalidate/validate record their own event occurrence without changing
`modifiedAt`.

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

For stale→fresh, the validate contains `clearsInvalidates`, the complete per-author invalidation frontier for its key/generation in the exact transaction-visible journal snapshot. Graph freshness and this immutable context commit atomically. This entry may be authored by ordinary genuine graph revalidation or by existing-live controlled reset's authoritative stale→fresh reconciliation. Both require coherent final validity and allocate after every referenced invalidate. No other path may author validate; in particular, normal synchronization and migration do not.

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

Conversely, passively carrying a stale materialization whose incoming proofs
are already absent and whose obligation is already represented by an
outstanding retained barrier neither newly establishes nor deliberately
reasserts hard invalidation, so it authors no barrier. Thus proof removal during
migration `keep`/`override`, explicit `invalidate()`, and
`create(..., "potentially-outdated")` require barriers, while an already-settled
passive carry does not.

The barrier carries the materialization's exact generation G. Its sequence is tentatively chosen from `localJournalClock` after observing the transaction snapshot and is greater than all history observed by the operation. Incoming-proof removal/reassertion, graph state, immutable barrier, notification record, allocators, high-watermark, and frontier commit atomically in the same darkroom batch. Each repeated explicit hard invalidation authors a fresh barrier: each call independently reasserts that the next pull must invoke the computor. Invalidation propagated by ordinary dependency mechanics may preserve complete validity proofs and continues to author only on its actual fresh→stale transition; such freshness-only propagation does not newly establish hard invalidation.

## Notification emission and synchronization coverage

Every authored logical entry atomically appends a self-contained record using the operation's semantic address `(key,nodeName,bindings)` and the entry time. The key must equal the identity-preserving key derived from that address. A notification-relevant transition not otherwise covered appends
one final-state same-key witness; this creates no logical event and changes no
graph timestamp. `Unchanged` is wholly silent.

For synchronization fixed snapshots R (receiver), S (source), and final F, let HR
and HS be their durable record high-watermarks. Compare the canonical compacted
logical per-key view plus materialization presence, `ComputedValue` when present,
freshness, and hard-invalidation/proof-sufficiency state. Identifier-, encoding-,
timestamp-, and harmless-validity-only differences are excluded.

For each K where the combined notifying view of R differs from that of F, F must contain
a same-key record above HR. An imported record may satisfy this; otherwise append
one final witness. If S contributes any strictly newer coverage-frontier
coordinate, then for each K where the combined notifying view of S differs from
that of F, F must additionally contain a same-key record above HS.
Use the greater threshold when both apply. Raise the record allocator above all
observed high-watermarks before appending. Only after all graph, logical and
notification effects are ready may coverage advance componentwise and its local
coordinate be set to the final high-watermark. Everything commits atomically.

Raw record receipt is silent. Synchronizing unchanged S twice adds nothing the
second time because S contributes no newer frontier and R's view no longer
changes. In the opposite direction, importing a reconciliation record needs no
echo when the final state equals its source; only a genuine source-to-final
difference requires a later record. Therefore, after semantic activity and
externally invoked resets stop, repeated ordinary synchronization of unchanged
hosts reaches a fixed point and appends no new notification records.
Synchronization still invokes no computor, copies value
provenance rather than authoring add/edit, and authors logical delete/invalidate
only under the existing classifier and hard-invalidation invariant.

## Controlled-reset reconciliation

Reset retains receiver-owned logical authority and does not join source logical
history. It does merge source records, source high-watermark, and source coverage frontier, while retaining receiver fingerprint and ownership of both local allocators. It raises its record allocator above imported positions and applies
the same source-to-final coverage rule. Self-contained `(key,nodeName,bindings,time)` payloads can
cover historical keys even where no source logical witness is retained. Local
reset add/delete/invalidate/validate entries and their records commit atomically.
An identical repeated reset is silent after coverage is incorporated. Existing
presence-generation, timestamp, freshness and causal-validation reset rules are
unchanged.

Existing-live controlled reset is an external administrative intervention, not
a continuously running reconciliation protocol. Global convergence and
quiescent-fixed-point claims assume eventual reset quiescence (finite reset
churn): in the relevant execution suffix, only finitely many existing-live
controlled resets occur. Equivalently, after some point no new controlled reset
is invoked while the system is being allowed to converge; ordinary
synchronization may continue arbitrarily often after that point. This liveness
premise does not weaken the safety or atomicity of any completed reset, its
cursor no-false-negative guarantee, same-receiver repeated-reset silence,
ordinary synchronization fixed points after resets stop, or
restart/migration/compaction safety.

## Reachability invariant

All correctness arguments use the
[journal supported-state boundary](incremental-graph-journal-types.md#supported-state-boundary)
and therefore range over snapshots reachable through atomic normal mutations,
migrations that preserve these invariants, and the synchronization protocol.
Arbitrary mismatched graph/journal pairs are corrupted or unsupported under the
definition in `database-lifecycle.md`, not ordinary conflicts. Defensive
validation MAY reject some such inputs, but complete detection is not a protocol
correctness obligation.
