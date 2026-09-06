# IncrementalGraph Journal 2 Locking and Atomicity

## Purpose

This specification adds Journal 2 requirements to the existing IncrementalGraph locking design without changing the public daytime/nighttime semantics.

The exact sleeper key names may evolve; the required serialization/atomicity properties below are normative.

## Commit serialization

The existing per-replica commit/darkroom serialization is the publication boundary for Journal 2.

A transaction which authors journal history must finalize, under the same per-replica commit serialization, all applicable pieces of:

- legacy graph writes/deletes;
- semantic event-ID allocation state;
- high-level operation-ID allocation state;
- high-level operation records;
- raw low-level semantic journal events;
- node summaries;
- changed-node marker movement;
- header causal/counter metadata;
- identifier lookup/allocation writes.

No semantic event ID may become durable without the graph/journal transition it names, and no named graph transition may commit without the corresponding event/summary update.

When a high-level operation record is persisted for a transition, its `localOperationCounter` update, the operation record, and all directly linked low-level events committed by that transition are part of the same publication boundary.

## Journal allocators

Allocation of local semantic event sequences and local operation sequences is serialized per writable replica during publication.

Two transactions may execute their expensive pull/computor work concurrently where the existing graph locking design permits, but their final IDs are chosen/published in the serialized finalization phase.

Semantic event allocation uses the then-current:

```text
localJournalCounter
causalSummary
```

and allocates above every semantic coordinate it is required to have observed.

High-level operation allocation uses the separate:

```text
localOperationCounter
```

and does not modify `causalSummary` or semantic event authority.

A transaction which fails before publication exposes no durable semantic event ID or operation ID. Reuse of an uncommitted tentative number is permitted because no supported observer could have seen it.

Committed semantic event coordinates and committed operation coordinates are never reused within their respective identity domains.

## Reconciliation at commit

Because dependency pulls may commit before a parent and concurrent same-replica transactions may finish in different orders, a transaction must validate/reconcile its proposed journal certificate/event against current committed graph/journal state during finalization.

In particular, a `ValidateEvent` may publish only if:

- the node still has the value occurrence the certificate names;
- every recorded basis entry corresponds to the input values actually consumed by the successful pull/revalidation;
- the operation's correctness remains valid under the existing graph concurrency invariants.

If current committed state invalidates the proposed result, use the same retry/failure policy required by the existing graph transaction model; do not publish a fictitious certificate.

## Causal-summary observation

A synchronization operation may join remote `causalSummary` into local journal metadata without allocating an event.

This metadata write must still be serialized/durable with any semantic synchronization transition that relies on that observation before authoring a new local event.

If synchronization authors a soft invalidation or tombstone in response to source authority, the source causal coordinates are joined before semantic sequence allocation, ensuring the new event is causally after and has greater total authority than the observed source facts.

High-level operation records do not participate in this causal observation.

## Full synchronization and lifecycle exclusion

Full synchronization continues to use the existing exclusive synchronization/lifecycle boundary and inactive-replica construction strategy.

The source and local input snapshots used by one semantic merge must be stable. The constructed target must contain a matching legacy graph and Journal 2 state before active cutover.

Normal pull/invalidate activity must not observe a partially constructed synchronization target.

## Reset and migration

Migration and controlled reset run under the existing holiday/exclusive lifecycle mode.

Their multi-node bootstrap event allocation may be performed while building an inactive replica, but the complete resulting graph+journal state becomes visible only at the final supported cutover.

Reset changes `journalIncarnation` atomically with installation of its rebuilt summaries/change index.

Controlled reset also atomically deletes every receiver-local stored source cursor (`journal/cursors/*`). This deletion belongs to the same reset publication boundary as the replacement graph/journal baseline. A reset state with old receiver-local source cursors still present is not a supported committed state.

## Metadata iterator snapshots

The generic metadata-only journal delta iterator does not require daytime/nighttime graph semantics, but it must read one fixed committed replica snapshot.

A conforming metadata iterator may:

1. acquire whatever replica-lifetime protection is required to keep the active replica alive;
2. take a LevelDB snapshot;
3. read header, changed-node markers, and node summaries completely from that same snapshot;
4. materialize the metadata-only `JournalDelta` into ordinary memory;
5. release the database snapshot/lifetime protection before returning the result.

No database snapshot or mutable active-replica reference may escape to a slow external iterator consumer.

The returned `JournalDelta` contains only bounded journal records; callers may inspect it after the database snapshot is released.

## Incremental synchronization source snapshot

Incremental synchronization has a stronger source-read requirement than the generic metadata iterator because selected present heads may require `ComputedValue` and timestamp records from legacy sublevels.

For one incremental `R <- S`, synchronization must own one fixed committed source snapshot while it reads:

- the source header;
- changed-node markers;
- changed node summaries;
- every source legacy value/timestamp record required to materialize a selected present `ValueId`.

It is invalid to obtain a detached `JournalDelta`, release its source snapshot, reopen the live source database, and then fetch a payload by NodeKey or current identifier. The reopened source may have advanced to another `ValueId` or deleted the node.

The synchronization procedure may release its source snapshot only after every required payload/timestamp record has been copied or safely staged. It may stream such records directly into an inactive target replica so no requirement exists to hold all payloads in RAM simultaneously.

The source snapshot remains internal to the synchronization procedure and still must not escape to an external iterator consumer.

## Lock ordering

Any dedicated journal allocator mutex, if implementation requires one distinct from the per-replica commit mutex, must be acquired before the per-replica final commit lock and after any graph phase/node locks already required by the operation.

No journal allocator/finalization path may acquire a telescope lock after acquiring the commit lock. The implementation must preserve one global acquisition order and the deadlock-freedom guarantees of the base locking design.

## Compaction

Canonical journal compaction is a persistence transformation, not ordinary graph activity.

It may execute while building an inactive replica under an already-exclusive lifecycle operation, or under another protocol which guarantees that:

- it folds one fixed committed journal state;
- it cannot race a publication into a half-compacted representation;
- its final active state has the identical legacy graph projection;
- cursor coordinates/incarnation are unchanged for cursors not invalidated by lifecycle replacement.

Compaction never requires holding all journal entries in RAM simultaneously; it must be streamable over LevelDB records and must respect the per-record `O(R log H)` bound.