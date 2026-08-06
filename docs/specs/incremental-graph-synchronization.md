# Incremental graph synchronization

## Independent authoritative and notification results

```text
finalGraph  = synchronizeAuthoritativeGraphs(localGraph, remoteGraph)
finalClock  = joinClock(localClock, remoteClock)
```

These calculations are independent. The authoritative graph merge chooses graph
state and conflict winners. The clock never influences `finalGraph`, and graph
state is never projected from `finalClock`.

For clock progress, compute `RemoteAdvancedActions` as every `(K,A)` for which at
least one origin's final sequence exceeds its local sequence. If multiple
origins advanced, make one local delivery and use the time from the greatest
advanced `(sequence, JournalOriginId)` component.

Independently classify `localGraph` versus `finalGraph` with the five exact rules
to obtain `SyncGraphActions`. This covers a synchronization-created local value
or freshness transition even when no incoming clock component advanced for that
action. The delivery set is:

```text
RemoteAdvancedActions union SyncGraphActions
```

Duplicate coordinates coalesce. A coordinate in `SyncGraphActions` uses local
cutover time. Synchronization-created graph differences make delivery records
but do **not** advance the local synchronized clock: synchronization order and
grouping must not manufacture replicated progress. Remote progress or a future
local-versus-final graph comparison supplies coverage elsewhere.

## Inactive replica protocol

1. Acquire the graph lifecycle holiday.
2. Acquire shared garden access and select the active local replica.
3. Open one fixed committed source snapshot `S`.
4. Capture from `S` the authoritative local graph, `NotificationClock`,
   `DeliveryByIndex`, `DeliveryHead`, `JournalOriginId`, and
   `lastLocalJournalIndex`.
5. Release shared garden access.
6. Obtain and validate the remote authoritative graph and clock.
7. Calculate `finalGraph` and `finalClock` independently.
8. Initialize the inactive destination by exact-copying local delivery indexes,
   origin identity, watermark, and clock from `S`.
9. Install `finalClock`.
10. Append-or-replace delivery records for the union above, allocating only
    indices greater than the copied watermark.
11. Install `finalGraph` and validate the complete destination.
12. Acquire exclusive garden access, atomically switch active replica, release
    locks.

Remote physical delivery records are never copied or merged. Exact local copying
preserves old cursor positions and gaps through cutover.

## Coverage traces

- If graph conflict resolution changes local value without a matching remote
  `edit` advancement, `SyncGraphActions` adds local `edit` at cutover time but
  does not increment the local clock.
- Remote add then delete advances both action coordinates and yields both local
  deliveries even if final local graph remains absent.
- A pre-cutover cursor remains meaningful because source indices and watermark
  are copied exactly and all new records are above that watermark.

## Reset

Reset is an authoritative local graph mutation. It compares before/after graphs,
classifies every affected key, advances local clock components, replaces local
deliveries, and commits all changes atomically. It does not reconstruct graph
state from the journal, replace delivery history, reset `JournalOriginId`, lower
or reset the watermark, or create a special reset event.

A reset trace keeps origin `O` and watermark 90; deleting K emits `delete`,
advances `clock[K][O].delete`, and allocates an index above 90.
