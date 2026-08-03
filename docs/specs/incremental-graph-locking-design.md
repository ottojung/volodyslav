# Incremental Graph — Locking Design

This document connects synchronization, migration, reset, and journal queries to
the general graph locking model defined in `incremental-graph.md` § Locking
Model. It restores that model; it does not replace it with a journal-only
summary. The lock design has no synchronization semantics of its own.

---

## 1. General graph locking model

The graph uses phase exclusion based on mode mutexes, per-node telescope locks,
a per-replica darkroom, and a shared/exclusive garden domain:

| Mode | Description |
|------|-------------|
| `daytime` | Non-`pull` graph operations (inspection reads plus `invalidate`). Multiple `daytime`-mode callers may execute concurrently. |
| `nighttime` | Recomputation operations. Multiple `nighttime`-mode callers may execute concurrently at the graph level (serialized per-node). |
| `holiday` | Lifecycle operations (database opens, schema migrations, synchronization freeze and cutover). Blocks all other modes. |

Additionally, `pull()` acquires a **per-node telescope mutex** inside the mode
mutex so two concurrent pulls never recompute the same node simultaneously.
Sequential consistency and the phase-exclusion properties of
`incremental-graph.md` § 5 apply unchanged.

---

## 2. Journal query access

`possibleMaybeChanges` acquires shared **garden** access, selects the active
replica, reads one fixed `last local physical JournalIndex = H`, scans
`(since, H]`, and releases the garden. It does not acquire the `holiday` mode or
the darkroom. Because synchronization holds `holiday` while freezing and cutting
over, queries cannot observe a partially installed merge.

---

## 3. Host-originated transaction finalization

A host-originated graph operation (`pull`, `invalidate`, first materialization,
explicit deletion) collects its entry emission in memory, acquires the
**darkroom** for finalization, allocates consecutive origin indices and
consecutive logical revisions, and commits graph-cache mutations, new journal
entries, new physical occurrences, and the advanced local `JournalIndex` in one
durable batch. Volatile state is published only after the durable commit
succeeds. A failed batch exposes none of it. `pull` runs in `nighttime` mode
with its per-node telescope; `invalidate` and other non-`pull` operations run in
`daytime` mode.

---

## 4. Synchronization and cutover

Synchronization is a `holiday`-mode lifecycle operation. It acquires the
`holiday` exclusion **before the local journal is frozen** and holds it through
active-replica cutover. During that interval no `pull()`, `invalidate()`,
migration, or reset can commit to the active replica, so no local operation can
be lost between the exported snapshot and the destination:

```text
1. acquire holiday (freeze local source)
2. export frozen local journal J0
3. obtain and validate staged snapshots
4. joinJournal(J0, staged) -> merged journal
5. projectGraph(schema, merged) -> final graph
6. build destination (inactive replica; each durable batch acquires the
   destination darkroom)
7. after all destination records are durable and internally consistent, finish
   finalization in the destination darkroom and atomically switch the
   active-replica pointer
8. release holiday
```

Failure before cutover leaves the previously active replica active and
unchanged. The destination is `joinJournal(frozenLocal, staged)`; because the
local source is frozen, the destination cannot omit a local operation committed
during synchronization.

---

## 5. Migration and reset

Migration and reset are also `holiday`-mode lifecycle operations. Migration
writes to an inactive destination and switches the active-replica pointer only
after a durable, internally consistent cutover. Reset is an ordinary bulk graph
operation that emits per-key entries in one batch under the same serialization
boundary; it does not install a target journal and does not alter the cursor
domain or origin identity.
