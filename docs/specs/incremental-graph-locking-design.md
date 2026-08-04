# Incremental Graph — Locking Design

This document connects synchronization, migration, reset, compaction, and journal
queries to the general graph locking model defined in `incremental-graph.md` §
Locking Model. The lock design has no synchronization semantics of its own.

---

## 1. General graph locking model

The graph uses phase exclusion based on mode mutexes, per-node telescope locks,
a per-replica darkroom, and a shared/exclusive garden domain:

| Mode | Description |
|------|-------------|
| `daytime` | Non-`pull` graph operations (inspection reads plus `invalidate`). Multiple `daytime`-mode callers may execute concurrently. |
| `nighttime` | Recomputation operations. Multiple `nighttime`-mode callers may execute concurrently at the graph level (serialized per-node). |
| `holiday` | Lifecycle operations (database opens, schema migrations, synchronization freeze). Blocks all other modes. |

`holiday` excludes graph writers: `pull`, `invalidate`, migration, reset, and
other graph activity. It does NOT protect journal queries, because
`possibleMaybeChanges` never acquires the graph mode mutex.

The garden domain protects physical replica selection and traversal:

```text
enterGarden:
    shared protection for selecting and traversing one physical replica

closeGarden:
    exclusive protection for active-pointer cutover and destructive physical
    journal operations (for example active-journal compaction)
```

---

## 2. Journal query access

`possibleMaybeChanges` acquires shared **enterGarden**, selects the active
replica, reads one fixed `last local physical JournalIndex = H`, scans
`(since, H]`, and releases. It does not acquire the graph mode mutex, `holiday`,
or the darkroom. Queries are protected from cutover and destructive physical
operations by `closeGarden`, not by `holiday`.

---

## 3. Host-originated transaction finalization

A host-originated graph operation (`pull`, `invalidate`, first materialization,
explicit deletion) computes its intent and tentative graph work in the
transaction body, then acquires the **darkroom** for finalization. Inside the
darkroom it reads the current canonical journal, projects the current
authoritative assertion, reconciles the intent against it, derives the final
journal entries and the graph-cache mutation, allocates origin and physical
indices, and commits graph-cache mutations, new journal entries, new physical
occurrences, and the advanced local `JournalIndex` in one durable batch
(`incremental-graph-journal-emission.md` § 2). `pull` runs in `nighttime` mode
with its per-node telescope; `invalidate` and other non-`pull` operations run in
`daytime` mode.

---

## 4. Synchronization and cutover

Synchronization is a `holiday`-mode lifecycle operation. It uses the following
sequence, with a deadlock-free acquisition order of

```text
holiday -> closeGarden -> destination darkroom
```

No path may acquire these in reverse order.

```text
1. acquire holiday
2. freeze/export the local logical journal
3. obtain and validate staged snapshots
4. join and project
5. build the inactive destination
6. acquire closeGarden
7. wait for all existing enterGarden readers to leave
8. finish destination metadata and atomically switch active replica
9. release closeGarden
10. only now may the old replica be cleared or reused
11. release holiday
```

Building the inactive replica does not require closing the garden: readers still
traverse the unchanged active replica while steps 3-5 run. `closeGarden` is
acquired only at cutover, after which readers drain before the pointer switch.

For multi-host synchronization, the old replica from one cutover must never be
reused as the next inactive destination until the corresponding `closeGarden`
boundary has drained all readers that could have selected it.

**Cutover trace:**

```text
Q selects replica x under enterGarden
sync prepares y
sync requests closeGarden and waits
Q finishes scanning x and releases enterGarden
sync switches to y
only then may x be cleared
```

Failure before cutover leaves the previously active replica active and
unchanged. The destination is `joinJournal(frozenLocal, staged)`; because the
local source is frozen under `holiday`, the destination cannot omit a local
operation committed during synchronization.

---

## 5. Compaction

Physical compaction of the active journal is a destructive physical rewrite and
MUST acquire `closeGarden` for its complete duration. A query observes either
the pre-compaction or the post-compaction layout, never a mixture. Logical
compaction (`normalizeJournal`) has no physical effect and needs no garden
protection beyond the ordinary batch commit discipline.

---

## 6. Migration and reset

Migration is a `holiday`-mode lifecycle operation that builds an inactive
destination and switches the active-replica pointer through the same
`holiday -> closeGarden -> destination darkroom` order. Reset is an ordinary
bulk graph operation that emits per-key entries in one batch under `holiday`;
it does not install a target journal and does not alter the cursor domain or
origin identity.
