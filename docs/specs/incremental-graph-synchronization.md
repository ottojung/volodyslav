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
`holiday -> closeGarden -> destination darkroom`, see
`incremental-graph-locking-design.md` § Synchronization and cutover):

1. Acquire `holiday`. No local `pull()`, `invalidate()`, migration, or reset can
   commit to the active replica from the moment the local journal is frozen
   until active-replica cutover completes.
2. The exact local logical journal is exported into a logical snapshot
   (`normalizeJournal(entries)`, schema version, merge-protocol version, and the
   derived `LogicalSnapshotId`).
3. The transport adapter stores or transmits the exported snapshot and obtains
   the logical snapshots supplied by other hosts.
4. Each supplied logical snapshot is decoded and validated by the transport
   adapter. Validation rejects malformed shapes and, atomically, any payload
   disagreement under one `eventId` (INV-JT-02), runs
   `validateLogicalSnapshot` on each staged snapshot
   (`incremental-graph-journal-types.md` § Snapshot validation), and enforces
   the compatibility preconditions: a staged snapshot whose `schemaVersion` or
   `mergeProtocolVersion` differs from the local source is rejected with the
   same deterministic error in either operand order, before any union occurs
   (`incremental-graph-journal-sync.md` § Compatibility preconditions).
5. `joinJournal(local, staged)` produces the merged normalized journal.
6. `projectGraph(schema, merged)` produces the final graph, then
   `validateProjectedGraph` runs (`incremental-graph-journal-sync.md` §
   Projected-graph validation).
7. The final graph is compared with the pre-sync local graph; affected keys are
   determined.
8. The merged journal, the projected graph, the newly imported physical
   occurrences, and the notification carriers are installed atomically in the
   inactive destination.
9. Acquire `closeGarden`, wait for existing `enterGarden` readers to leave,
   finish destination metadata in the destination darkroom, and atomically
   switch the active-replica pointer; release `closeGarden` before the old
   replica may be cleared or reused.
10. Release `holiday`.
11. Staging storage is cleared after the attempt (whether it succeeded or
    failed).
12. Failures are recorded per host. Synchronization may continue with remaining
    hosts and aggregate failures into a single error report.

Because the local source is frozen under `holiday` for the whole procedure, the
destination is `joinJournal(frozenLocal, staged)` and cannot lose a local
operation committed during synchronization.

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
