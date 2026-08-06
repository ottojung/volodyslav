# Incremental Graph Synchronization

This document is a short orchestration wrapper around the journal join and graph
projection defined in `incremental-graph-journal-sync.md`. It contains no
independent merge authority.

---

## 1. Role

Synchronization is entirely:

```text
joinJournal          (incremental-graph-journal-sync.md § Synchronization join)
projectGraph         (incremental-graph-journal-sync.md § Deterministic graph
                      projection)
install + carriers   (incremental-graph-journal-sync.md § Synchronization
                      installation and notifications)
```

There is no candidate set, merge basis, causal frontier, provenance, host-state
version, sync-derived event, or sync creator anywhere in the system.

---

## 2. Per-host synchronization procedure

Normal synchronization follows these steps in order (lock acquisition order is
`holiday -> enterGarden -> closeGarden -> destination darkroom`; see
`incremental-graph-locking-design.md` § Synchronization and cutover):

1. Acquire `holiday`. No local `pull()`, `invalidate()`, migration, or reset can
   commit to the active replica from the moment the local journal is frozen
   until active-replica cutover completes.
2. Acquire `enterGarden` (synchronization acts as a shared garden reader while
   capturing one fixed committed physical view).
3. Select the currently active physical replica.
4. Open one fixed committed snapshot `S` of the active replica: its physical
   occurrences, exact `LocalJournalIndex`es, gaps/absences, and the physical
   watermark visible to the active journal. `S` is a LevelDB snapshot or an
   equivalent fixed committed iterator view.
5. Export the local normalized logical journal from a state consistent with `S`
   (`normalizeJournal(entries)`, schema version, merge-protocol version, and the
   derived `LogicalSnapshotId`).
6. Release `enterGarden`.
7. The transport adapter stores or transmits the exported snapshot and obtains
   the logical snapshots supplied by other hosts.
8. Each supplied logical snapshot is decoded and validated by the transport
   adapter. Validation rejects malformed shapes and, atomically, any payload
   disagreement under one `eventId` (INV-JT-02), runs
   `validateLogicalSnapshot` on each staged snapshot
   (`incremental-graph-journal-types.md` § Snapshot validation), and enforces
   the compatibility preconditions: a staged snapshot whose `schemaVersion` or
   `mergeProtocolVersion` differs from the local source is rejected with the
   same deterministic error in either operand order, before any union occurs
   (`incremental-graph-journal-sync.md` § Compatibility preconditions).
9. `joinJournal(local, staged)` produces the merged normalized journal.
10. `projectGraph(schema, merged)` produces the final graph, then
    `validateProjectedGraph` runs (`incremental-graph-journal-sync.md` §
    Projected-graph validation).
11. The final graph is compared with the pre-sync local graph; affected keys are
    determined.
12. The inactive destination's local physical history is built entirely from the
    immutable snapshot `S` (every surviving occurrence, its exact
    `LocalJournalIndex`, physical gaps/absences, and the copied watermark), then
    the destination's canonical logical journal and projected graph are replaced
    by the join result, and newly imported occurrences and notification carriers
    are appended at fresh indices strictly greater than the copied watermark
    (allocated from the root-local allocator).
13. Validate the destination.
14. Acquire `closeGarden`, wait for existing `enterGarden` readers to leave,
    finish destination metadata in the destination darkroom, and atomically
    switch the active-replica pointer; release `closeGarden` before the old
    replica may be cleared or reused.
15. Release `holiday`.
16. Staging storage is cleared after the attempt (whether it succeeded or
    failed).
17. Failures are recorded per host. Synchronization may continue with remaining
    hosts and aggregate failures into a single error report.

The snapshot `S` must remain readable after `enterGarden` is released. If the
storage abstraction cannot provide such a durable read snapshot, synchronization
holds `enterGarden` for the complete physical copy, releases it after copying,
and only then requests `closeGarden`. Synchronization never requests
`closeGarden` while holding `enterGarden`; there is no shared-to-exclusive lock
upgrade.

Because the local source is frozen under `holiday` for the whole procedure, the
destination is `joinJournal(frozenLocal, staged)` and cannot lose a local
operation committed during synchronization. Because the destination is built
entirely from the fixed committed view `S`, its physical history is exactly the
physical source view represented by `S`, and same-process cursors remain valid
across the cutover: logical state comes from `joinJournal`, local physical
history comes from `S`.

Synchronization creates no new logical event IDs, no sync creator, and no
sync-derived delete or invalidate event.

---

## 3. Graph synchronization independence

Graph synchronization correctness does not depend on physical journal layout,
compaction, or carrier positions. The projected graph is a deterministic
function of the schema and the normalized journal only.

---

## 4. Reset

Reset is an ordinary bulk graph operation (`incremental-graph-journal-emission.md`
§ Reset). An outer adapter resolves a hostname to a validated target graph and
compares it against the current projection; the difference is emitted as ordinary
per-key entries in one atomic batch. The target journal is never installed,
journal lineage and cursor domain are never altered, and origin identity is
preserved.

---

## 5. Migration

Migration emits ordinary per-key entries using the same transition rules
(`incremental-graph-journal-migrations.md`). A migration destination is built in
an inactive replica and becomes active only after a durable, internally
consistent cutover.
