# IncrementalGraph Journal 2 Locking and Atomicity

## Purpose

This specification adds Journal 2 requirements to the existing IncrementalGraph locking design without changing the public daytime/nighttime semantics.

The exact sleeper key names may evolve; the required serialization/atomicity properties below are normative.

## Commit serialization

The existing per-replica commit/darkroom serialization is the publication boundary for Journal 2.

A transaction which authors journal history must finalize, under the same per-replica commit serialization, all applicable pieces of:

- legacy graph writes/deletes;
- semantic event-ID allocation state;
- semantic HLC authority-clock allocation state;
- high-level operation-ID allocation state;
- high-level operation records;
- raw low-level semantic journal events;
- node summaries;
- changed-node marker movement;
- header causal/counter/authority metadata;
- identifier lookup/allocation writes.

No semantic event ID/authority may become durable without the graph/journal transition it names, and no named graph transition may commit without the corresponding event/summary update.

When a high-level operation record is persisted for a transition, its `localOperationCounter` update, the operation record, and all directly linked low-level events committed by that transition are part of the same publication boundary.

## Journal allocators

Allocation of local semantic event sequences, local HLC authority times, and local operation sequences is serialized per writable replica during publication.

Two transactions may execute their expensive pull/computor work concurrently where the existing graph locking design permits, but their final event IDs and HLC authority times are chosen/published in the serialized finalization phase.

Semantic event identity allocation uses only the then-current writer-local:

```text
localJournalCounter
```

and allocates:

```text
nextSequence = localJournalCounter + 1
```

Remote causal coordinates do not inflate the local sequence.

The event's immutable causal context is the then-current:

```text
causalSummary
```

The event's total conflict authority advances from the then-current:

```text
authorityClock
```

using the physical seed required by the types/emission specifications. The transaction must first join every causal/authority fact it is required to have observed.

High-level operation allocation uses the separate:

```text
localOperationCounter
```

and does not modify `causalSummary`, `authorityClock`, or semantic event authority.

A transaction which fails before publication exposes no durable semantic event ID, authority time, or operation ID. Reuse of an uncommitted tentative local sequence/operation number is permitted because no supported observer could have seen it; an uncommitted tentative HLC step likewise has no semantic existence.

Committed semantic event coordinates and committed operation coordinates are never reused by the writer. `localOperationCounter` is monotone across controlled reset even though `OperationId` also records the journal incarnation in which the operation occurred. `authorityClock` never moves backward across supported committed states.

## Reconciliation at commit

Because dependency pulls may commit before a parent and concurrent same-replica transactions may finish in different orders, a transaction must validate/reconcile its proposed journal certificate/event against current committed graph/journal state during finalization.

In particular, a `ValidateEvent` may publish only if:

- the node still has the value occurrence the certificate names;
- every recorded basis entry corresponds to the input values actually consumed by the successful pull/revalidation;
- the operation's correctness remains valid under the existing graph concurrency invariants.

If current committed state invalidates the proposed result, use the same retry/failure policy required by the existing graph transaction model; do not publish a fictitious certificate.

Any event IDs or authority times proposed before this reconciliation are tentative. Final writer-local sequence, context, and HLC authority must be allocated/reconciled against the current committed header in the serialized publication phase.

## Causal/authority observation

A synchronization operation may join remote `causalSummary` and `authorityClock` into local journal metadata without allocating an event.

These metadata writes must still be serialized/durable with any semantic synchronization transition that relies on those observations before authoring a new local event.

If synchronization authors a soft invalidation or tombstone in response to source authority:

1. the source causal coordinates are joined into `causalSummary`;
2. the source HLC high-water mark and directly inspected EventRef authority times are joined into `authorityClock`;
3. the new local event allocates its next writer-local sequence;
4. the new local event advances the HLC once.

Therefore the new event is causally after the observed source facts and greater than them in total authority, without comparing or copying remote sequence magnitudes into the local sequence counter.

High-level operation records do not participate in this causal/authority observation except that source-bearing records may store the observed source header as historical invocation metadata.

## Full synchronization and lifecycle exclusion

Full synchronization continues to use the existing exclusive synchronization/lifecycle boundary and inactive-replica construction strategy.

The source and local input snapshots used by one semantic merge must be stable. The constructed target must contain a matching legacy graph and Journal 2 state before active cutover.

Normal pull/invalidate activity must not observe a partially constructed synchronization target.

## Reset and migration

Migration and controlled reset run under the existing holiday/exclusive lifecycle mode.

Their multi-node bootstrap event allocation may be performed while building an inactive replica, but the complete resulting graph+journal state becomes visible only at the final supported cutover.

Reset changes `journalIncarnation` atomically with installation of its rebuilt summaries/change index and its resulting causal/authority header state.

Controlled reset also atomically deletes every receiver-local stored source cursor (`journal/cursors/*`). This deletion belongs to the same reset publication boundary as the replacement graph/journal baseline. A reset state with old receiver-local source cursors still present is not a supported committed state.

## Private possible-maybe-changes iterator

`possibleMaybeChanges(sourceSnapshot, cursor)` is a private database/journal API. It is not exposed through the public `IncrementalGraph` object and is not available to computors.

The API does not independently acquire a long-lived graph/lifecycle lock. Its internal caller supplies a fixed committed source snapshot whose lifetime is already protected by the surrounding synchronization/lifecycle operation.

While that snapshot remains alive, the iterator lazily range-scans changed-node markers and reads the corresponding current node summaries from the same snapshot. It yields one bounded change record at a time and MUST NOT materialize the complete changed-node range in RAM.

The iterator must remain inside the synchronization/journal module boundary. It may not escape to an arbitrary external consumer which could retain it across unrelated graph operations or outlive the caller-owned snapshot.

If iteration completes, fails, or is abandoned, the caller must finish/close the iterator before releasing the source snapshot.

## Incremental synchronization source snapshot

For one incremental `R <- S`, synchronization owns one fixed committed source snapshot while it consumes `possibleMaybeChanges` and reads:

- the source header, including causal and HLC authority high-water metadata;
- changed-node markers and current changed-node summaries;
- every source legacy value/timestamp record required to materialize a selected present `ValueId`.

It is invalid to consume change metadata from one snapshot, release that snapshot, reopen the live source database, and then fetch a payload by NodeKey or current identifier. The reopened source may have advanced to another `ValueId` or deleted the node.

The synchronization procedure may release its source snapshot only after the private async iterator is finished and every required payload/timestamp record has been copied or safely staged. Payload records may be streamed directly into an inactive target replica so no requirement exists to hold all payloads in RAM simultaneously.

The source snapshot remains internal to the synchronization procedure and is never exposed through a public iterator API.

## Lock ordering

Any dedicated journal allocator mutex, if implementation requires one distinct from the per-replica commit mutex, must be acquired before the per-replica final commit lock and after any graph phase/node locks already required by the operation.

No journal allocator/finalization path may acquire a telescope lock after acquiring the commit lock. The implementation must preserve one global acquisition order and the deadlock-freedom guarantees of the base locking design.

## Compaction

Canonical journal compaction is a persistence transformation, not ordinary graph activity.

It may execute while building an inactive replica under an already-exclusive lifecycle operation, or under another protocol which guarantees that:

- it folds one fixed committed journal state;
- it cannot race a publication into a half-compacted representation;
- its final active state has the identical legacy graph projection;
- writer-local sequence coordinates, causal summary, HLC authority high-water state, and cursor coordinates/incarnation are unchanged for cursors not invalidated by lifecycle replacement.

Compaction never requires holding all journal entries in RAM simultaneously; it must be streamable over LevelDB records and must respect the per-record `O(R log H)` bound.
