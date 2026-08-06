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
transaction body, then acquires the **activeReplicaDarkroom** for finalization.
Inside the darkroom it reads the current canonical journal, projects the current
authoritative assertion, reconciles the intent against it, derives the final
journal entries and the graph-cache mutation, allocates origin and physical
indices from the root-local allocator, and commits graph-cache mutations, new
journal entries, new physical occurrences, and the advanced root-local
`lastLocalJournalIndex` in one durable batch
(`incremental-graph-journal-emission.md` § 2). `pull` runs in `nighttime` mode
with its per-node telescope; `invalidate` and other non-`pull` operations run in
`daytime` mode.

The root-local physical/event allocator (`lastLocalJournalIndex`) is shared by
both replica slots. A failed inactive migration or synchronization destination
build may advance it and leave gaps, but never reuses a `(hostname,
originIndex)` provenance tuple
(`incremental-graph-journal-types.md` § 2.1).

---

## 4. Synchronization and cutover

Synchronization is a `holiday`-mode lifecycle operation. It uses the following
sequence, with a deadlock-free acquisition order of

```text
holiday -> enterGarden -> closeGarden -> destination darkroom
```

No path may acquire these in reverse order, no path may hold a darkroom and then
request `closeGarden`, and synchronization never upgrades `enterGarden` to
`closeGarden` (there is no shared-to-exclusive lock upgrade).

```text
1. acquire holiday

2. acquire enterGarden

3. select the currently active physical replica

4. open one fixed committed snapshot S of:
       physical occurrences
       exact LocalJournalIndices
       gaps/absences
       the physical watermark visible to the active journal

5. export the local normalized logical journal from a state consistent with S

6. release enterGarden

7. obtain and validate remote logical snapshots

8. calculate joinJournal and projectGraph

9. build the inactive destination's local physical history entirely from S

10. append newly imported occurrences and notification carriers at fresh
    root-local indices

11. validate the destination

12. acquire closeGarden

13. drain existing enterGarden readers

14. switch the active pointer atomically

15. release closeGarden

16. release holiday
```

The snapshot `S` must remain readable after `enterGarden` is released. If the
storage abstraction cannot provide such a durable read snapshot, synchronization
holds `enterGarden` for the complete physical copy, releases it after copying,
and only then requests `closeGarden`. Building the inactive replica does not
require closing the garden: readers still traverse the unchanged active replica
while steps 7-11 run. `closeGarden` is acquired only at cutover, after which
readers drain before the pointer switch.

### Lock relationships

```text
possibleMaybeChanges:
    enterGarden while selecting and scanning

synchronization source capture:
    enterGarden while selecting active replica and opening/copying its fixed view

physical compaction:
    closeGarden while applying exact deletes

synchronization cutover:
    closeGarden while switching the active pointer
```

Because synchronization captures its source under `enterGarden`, and compaction
applies exact deletes under `closeGarden`, the two are mutually exclusive over
the same replica: compaction cannot delete an occurrence while synchronization
is opening or copying its fixed view, and synchronization's view `S` is a fixed
committed snapshot that remains readable after `enterGarden` is released.

### Compaction-source race traces

Both orderings preserve same-process cursor coverage:

**Compaction after sync captures:**

```text
sync acquires enterGarden and opens snapshot S of replica x

compaction requests closeGarden
    -> compaction waits

sync releases enterGarden

compaction acquires closeGarden and deletes obsolete exact indices from live x

sync continues building destination y from immutable S

destination y contains exactly the physical source view represented by S
```

**Compaction before sync captures:**

```text
compaction finishes first
sync then opens S
destination copies the post-compaction layout exactly
```

For multi-host synchronization, the old replica from one cutover must never be
reused as the next inactive destination until the corresponding `closeGarden`
boundary has drained all readers that could have selected it.

Failure before cutover leaves the previously active replica active and
unchanged. The destination is `joinJournal(frozenLocal, staged)`; because the
local source is frozen under `holiday`, the destination cannot omit a local
operation committed during synchronization. Because the destination is built
entirely from the fixed committed view `S`, same-process cursors remain valid
across the cutover.

---

## 5. Compaction

Physical compaction mutates the physical journal only through exact deletes
(`incremental-graph-journal-compaction.md` § 2). It acquires `closeGarden` so
readers observe either the pre- or post-deletion state, never a mixture. It
does NOT acquire `activeReplicaDarkroom`: writers append at fresh indices
strictly greater than the compaction watermark, so a committed append can never
fall inside a previously calculated delete set. No path holds a darkroom and
then requests `closeGarden`. Logical compaction (`normalizeJournal`) has no
physical effect and needs no garden protection beyond the ordinary batch commit
discipline.

---

## 6. Migration and reset

Migration is a `holiday`-mode lifecycle operation that builds an inactive
destination and switches the active-replica pointer through the same
`holiday -> closeGarden -> destination darkroom` order. A failed migration may
advance the root-local allocator and leave gaps, but the active graph, active
logical journal, and active physical occurrences are unchanged. Reset is an
ordinary bulk graph operation that emits per-key entries in one batch under
`holiday`; it does not install a target journal and does not alter the cursor
domain or origin identity.
