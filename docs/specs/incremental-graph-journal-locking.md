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

`operation` and `parent` are historical-only grouping fields with no effect on folding, authority, projection, synchronization, compaction correctness, or causality. Publication does not require the named operation record to still exist; readers must tolerate an unresolved grouping reference after historical compaction.

## Journal allocators

Allocation of local semantic event sequences, local HLC authority times, and local operation sequences is serialized per writable replica during publication.

Two transactions may execute their expensive pull/computor work concurrently where the existing graph locking design permits, but their final event IDs and HLC authority times are chosen/published in the serialized finalization phase.

The finalizer invokes the canonical semantic-event allocator defined in `incremental-graph-journal-types.md` against the then-current committed header after joining every causal/authority fact the transition is required to observe. This locking specification does not define a second allocation formula. In particular, remote causal coordinates never become writer-local sequence coordinates.

High-level operation allocation uses the separate monotone `localOperationCounter` defined by the types specification and does not modify `causalSummary`, `authorityClock`, or semantic event authority.

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

If synchronization authors a value-scoped invalidation or tombstone in response to source authority:

1. the source causal coordinates are joined into `causalSummary`;
2. the source HLC high-water mark is joined into `authorityClock`;
3. the new local event is allocated by the canonical semantic-event allocator.

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

A migration whose input already contains Journal 2 likewise atomically deletes every receiver-local stored source cursor as part of the migration publication. Cursor deletion must become visible in the same cutover as the migrated graph/journal state. A migrated Journal 2 state paired with pre-migration receiver-local source cursors is not a supported committed state. The next synchronization with each source is therefore full synchronization and may establish a fresh cursor after success.

The initial pre-Journal-2 bootstrap has no valid Journal 2 source cursors to delete.

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

Canonical journal compaction is standalone historical housekeeping against the active database. It is not a database lifecycle transition, is therefore not a `database-lifecycle.md` §14 maintenance transition requiring exclusivity, does not acquire `holiday`/exclusive lifecycle mode, and does not construct an inactive replica.

Each compaction batch runs in the existing IncrementalGraph `daytime` mode. Because `holiday` blocks every other graph mode, migration/reset/lifecycle cutover cannot overlap a compaction batch. Because `pull()` runs in `nighttime`, a pull cannot overlap a compaction batch either. Other `daytime` operations such as `invalidate()` may execute concurrently at the graph-mode level, with their durable writes still serialized by the per-replica commit boundary below.

Live authoring and synchronization already maintain the synchronization-relevant Journal 2 state on every publication. Compaction therefore MUST NOT rewrite `JournalHeader`, node summaries, changed-node markers, stored source cursors, or legacy graph state. Its writes are confined to the historical layer: deleting redundant raw semantic events and operation records.

Compaction runs as a sequence of implementation-bounded batches. Each batch:

1. acquires `daytime` mode for the current active replica;
2. acquires the same per-replica commit serialization used by ordinary publication;
3. while both are held, selects an implementation-bounded set of records which are already committed and historical in that current active replica;
4. atomically applies only that batch's historical deletes; and
5. releases the commit serialization and `daytime` mode before beginning the next batch.

Candidate sets never survive release of `daytime` mode. If the database is closed or a lifecycle transition replaces the active replica between batches, compaction abandons the remaining work; a later attempt re-selects candidates from the then-current active replica. Already committed prune batches remain valid, so abandonment requires no rollback.

The amount of selection and deletion work in one batch is implementation-bounded. A `pull()` can therefore be delayed by at most one bounded compaction batch before compaction releases `daytime`; a concurrent `invalidate()` is blocked only when it contends for the serialized commit boundary.

A failure after one or more batches have committed leaves those already-committed prune steps in place. Every committed intermediate state is a supported journal state with identical graph/synchronization semantics, so a later compaction attempt may simply continue from the remaining historical records.

Compaction never requires holding all journal entries in RAM simultaneously; it must be streamable over LevelDB records and must respect the per-record `O(R log H)` bound.
