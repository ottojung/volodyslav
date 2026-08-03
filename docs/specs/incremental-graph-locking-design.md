# Incremental Graph — Locking Design

This document defines the concurrency domain for the journal and graph.
Synchronization and host-originated transactions are serialized through a small
set of locks; the lock design has no synchronization semantics of its own.

---

## 1. Concurrency domain

Queries, host-originated transactions, synchronization, migration, and
compaction are coordinated with three conceptual locks:

- **garden** (`enterGarden` / `releaseGarden`): shared access for queries that
  read one fixed replica snapshot;
- **closeGarden**: exclusive access that prevents queries from selecting or
  traversing a replica while synchronization or cutover constructs the
  destination;
- **darkroom**: exclusive serialized finalization inside which journal
  revisions, origin indices, and physical indices are allocated and the durable
  batch is committed.

---

## 2. Query interaction

`possibleMaybeChanges` acquires the garden, selects the active replica, reads
one fixed `last local physical JournalIndex = H`, scans `(since, H]`, and
releases the garden. Because synchronization holds `closeGarden` while building
the destination, queries cannot observe a partially installed merge.

---

## 3. Host-originated transaction finalization

One host-originated graph operation collects its entry emission in memory,
acquires the darkroom for finalization, allocates consecutive origin indices and
consecutive logical revisions, and commits graph-cache mutations, new journal
entries, new physical occurrences, and the advanced local `JournalIndex` in one
durable batch. Volatile state is published only after the durable commit
succeeds. A failed batch exposes none of it.

---

## 4. Synchronization and cutover

Synchronization acquires `closeGarden` so queries cannot select or traverse a
replica during merge or cutover. The destination is built in an inactive
replica; each durable batch acquires the destination darkroom. After all
destination records (projected graph, normalized journal, occurrences, carriers,
watermark) are durable and internally consistent, finalization acquires the
destination darkroom, finishes the remaining durable metadata, and atomically
switches the active-replica pointer. Failure before cutover leaves the
previously active replica active and unchanged.

---

## 5. Compaction

Compaction performs logical normalization and physical duplicate-occurrence
deletion (`incremental-graph-journal-compaction.md`). It acquires exclusive
access so queries observe either the pre- or post-compaction layout, never a
partial one.
