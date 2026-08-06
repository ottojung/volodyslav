# Incremental graph locking and replica cutover

## Ownership

Each `GraphReplica` physically owns authoritative IncrementalGraph storage and
its notification journal (`NotificationClock`, `DeliveryByIndex`,
`DeliveryHead`, `JournalOriginId`, and `lastLocalJournalIndex`). The graph is the
sole authority; journal locks protect notification consistency, not graph
projection.

## Ordinary transaction boundary

The existing durable transaction-finalization boundary serializes authoritative
mutations, local clock increments, append-or-replace deletes/puts, head changes,
and watermark advancement. A committed snapshot contains all of a transition
and its coverage or none. Sequence overflow aborts rather than wraps.

## Queries

`possibleMaybeChanges` acquires shared garden access while selecting the active
replica and opening a fixed committed journal snapshot. It captures the
watermark within that snapshot, then scans `(since,H]`. The snapshot prevents a
query from observing neither side of an atomic delivery replacement.

## Synchronization and migration construction

A lifecycle holiday excludes competing structural work. Under shared garden
access, construction selects the active replica and opens one fixed committed
source snapshot containing the graph and all five journal parts. After capture,
shared access may be released while the inactive destination is built.

The destination exact-copies the local journal infrastructure before adding
records above the copied watermark. Synchronization joins only the remote clock;
it never imports remote delivery history. Migration likewise copies local
journal infrastructure, then records exact old/new authoritative transitions.

After destination validation, exclusive garden access serializes the atomic
active-replica switch. Existing readers finish on their selected replica; new
readers select the destination. Exact copied physical indices, heads, gaps, and
watermark preserve same-process cursor positions.

The required locks and snapshots are exactly those protecting authoritative
transactions, fixed journal reads, source capture, and replica cutover.
