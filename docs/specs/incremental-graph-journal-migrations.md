# Journal during migration

Migration builds authoritative graph state independently, starting from one
fixed receiver snapshot containing:

```text
durable HostFingerprint
StoredJournalEntry collection
localJournalClock
localJournalIndexWatermark
```

Within one running receiver, migration separately threads the receiver's
runtime-only cursor-domain identity into the inactive target; it never reads or
writes that identity as database or synchronization content. It copies every
retained entry and its receiver-local index exactly, then
validates immutable ID content, generation and validation-causal references,
same-author validation-context monotonicity, canonical compaction,
logical clock coverage, unique indexes, and index-watermark coverage. It never
imports another host's index or author ownership.

Migration applies the exact closed classifier. New logical entries use the host
clock, required generation, wall-clock occurrence `time`, required add/edit `valueModifiedAt`, and distinct fresh
local indexes. Any changed key without a newly indexed entry touches its greatest
retained witness. Graph, entries, touches, and watermarks commit atomically.
`Unchanged`, representation-only, identifier-only, and validity-only changes are
silent. Aborted inactive construction exposes no index advancement and index
values are never reused after publication.

The closed transition classifier is not sufficient when migration hardens an
already-stale cache. Whenever `keep` or `override` discards a stale node's
incoming proofs, explicit migration `invalidate()` removes/reasserts those
proofs, or `create(..., "potentially-outdated")` establishes a must-recompute
materialization, migration authors an ordinary generation-scoped
`InvalidateJournalEntry` unless a barrier produced by that same migration
decision already represents the exact obligation. The barrier uses the existing
generation (or the new create add generation), is allocated above every journal
entry observed by migration, participates normally in `invalidateFrontier`, and
commits atomically with graph/proof state, its fresh local index, and both
watermarks. Migration introduces no special action.

A migrated node already hard-invalidated with absent incoming proofs and an
outstanding retained barrier may be carried without another entry when migration
makes no new proof-removal or deliberate hardening decision. Thus the global
invariant prevents missing obligations without creating barriers for settled
state. Compaction treats migration-authored invalidates identically, including
the fully compacted `O(nr²)` bound.
