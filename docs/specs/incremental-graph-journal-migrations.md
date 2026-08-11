# Journal during migration

This migration specification applies only after the journal subsystem has been
established. It does not describe upgrading a database created by a pre-journal
implementation; database-version migration here operates within the target
journal-enabled persistent model described by the journal
[implementation/rollout scope](../incremental-graph-journal.md#implementationrollout-scope).

Migration builds authoritative graph state independently, starting from one
fixed receiver snapshot containing:

```text
durable IncrementalGraph database fingerprint (journal HostFingerprint)
StoredJournalEntry collection
localJournalClock
localJournalIndexWatermark
```

Within one running receiver, migration separately threads the receiver's
runtime-only cursor-domain identity into the inactive target; it never reads or
writes that identity as database or synchronization content. It copies every
retained entry and its receiver-local index exactly, then checks the structural
invariants required to load retained state: generation and retained
validation-causal reference resolution, identity, and ordering; logical clock
coverage; unique valid indexes; and index-watermark coverage. It MAY also check
immutable-ID conflicts and same-author validation-context monotonicity
defensively when the relevant evidence remains. These checks do not promise complete diagnosis of
corrupted/unsupported history after compaction, and absence of discarded
evidence is not migration failure. It never imports another host's
index or author ownership and uses the
[journal supported-state boundary](incremental-graph-journal-types.md#supported-state-boundary).

A supported migration MUST accept a structurally valid supported journal even
when it contains uncompacted history. Non-canonical representation is not
corruption, and cutover does not require `J == compact(J)`. Migration does not
run an implicit compaction pass, create notification-witness touches merely for
compaction, or move local indexes for otherwise unchanged keys. It copies the
retained history and indexes, then authors, indexes, or touches only what its
semantic migration transitions require. Thus a journal-silent same-process
migration retains the cursor domain, entries, indexes, and watermark unchanged;
real migration activity may advance the watermark only through its ordinary
entry/touch rules. An independently requested compaction remains a separate
operation with the ordinary compaction cursor-coverage rules.

For example, a reachable journal may contain several superseded entries at one
same-author/key/action coordinate because compaction has been skipped. Migration
may exact-copy all of them and cut over successfully without compacting. A
journal-silent migration leaves their indexes unchanged; a genuine graph
transition adds or touches only the normal witness for that transition.

Migration applies the exact closed classifier. New logical entries use the host
clock, required generation, wall-clock occurrence `time` (equal to resulting `modifiedAt` for add/edit), and distinct fresh
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
state. Repeating such a passive `keep` or `override` authors no barrier, assigns
no local index, and advances no journal clock for this reason. An explicit
`invalidate()` is instead a deliberate reassertion and MUST author a fresh
barrier even from this settled starting state. Compaction treats migration-authored invalidates identically, including
the fully compacted `O(nr²)` bound.
