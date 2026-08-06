# Incremental Graph Journal — Migrations

This document defines migrations as ordinary local entry emission over an
inherited authoritative journal. A migration changes the graph schema or the
installed graph state and emits the same journal entries as any other graph
operation; its authoritative result is the normalization of the inherited
canonical journal with the migration-generated events.

---

## 1. Migration as ordinary emission

Migration-generated `add`, `edit`, `delete`, `invalidate`, and `validate`
entries follow the identical transition-to-entry matrix
(`incremental-graph-journal-emission.md` § Transition-to-entry matrix) and the
identical atomic batching discipline. There is no host-state version, no
operation ID, and no migration-specific journal semantics.

Migration compares the **complete journal-projected assertion** — value,
logically relevant identifier and timestamps, stored freshness, and the input
proof map under the new schema — not merely observable value and freshness. A
migration operation may emit nothing only when the resulting authoritative
assertion is unchanged.

Entries that reference other entries from the same migration batch are
constructed and hashed in acyclic dependency order
(`incremental-graph-journal-types.md` § Construction order for multi-entry
batches and `incremental-graph-journal-emission.md` § 2.6): each new state
entry's complete proof map is built before it is hashed, with every referenced
input's final event ID resolved first; a newly created `add` for an input node
is hashed before the `add` for its dependant, so the dependant's proof map
references the input's digest; a state entry is hashed before the freshness
entry whose `subjectStateEventId` names it.

For example:

- `storage.create` of a node emits `add` carrying the complete materialization
  and its actual initial freshness;
- a value rewrite (including a semantic `OVERRIDE` that changes the logical
  `ComputedValue`) emits `edit`;
- a stale node carried through `keep` or `override` that loses its incoming
  proofs emits `invalidate` with an empty proof map (the authoritative proof
  assertion changed even though the value and freshness did not);
- a proof-map change under a fixed state emits the applicable freshness entry
  (`validate` for up-to-date, `invalidate` for stale);
- a revalidation emits `validate` for the current selected state event;
- a deletion emits `delete`;
- a representation-only `OVERRIDE` that stores the same logical `ComputedValue`
  and changes only the rebuildable physical encoding emits nothing.

### Emitted-event atomicity

Every emitted journal entry is committed in the same atomic durable batch as
the graph-cache mutation and the freshness change that caused it. No reader can
observe one without the other.

---

## 2. Migration source capture

A migration begins from the active canonical journal, never from an empty
journal. Unchanged `KEEP` and representation-only `OVERRIDE` operations emit no
journal entry, so the destination must explicitly inherit the active canonical
journal.

Migration is a `holiday` lifecycle operation, but compaction does not acquire
`holiday`. Therefore migration acts as a shared garden reader while capturing
its authoritative source, using two distinct lock phases (the same notation as
synchronization):

```text
source capture:
    holiday -> enterGarden -> release enterGarden

cutover:
    holiday -> closeGarden -> destination darkroom
```

```text
1. acquire holiday

2. acquire enterGarden

3. select the active source replica

4. open one fixed committed source view S sufficient to derive:
       - the canonical logical journal J0;
       - the old graph state and metadata required by MigrationStorage

5. derive:
       J0 = normalizeJournal(logicalEvents(S))

6. release enterGarden
      (source capture phase complete)
```

`S` must remain readable after `enterGarden` is released. If the storage layer
cannot provide that guarantee, complete the required source copy while holding
`enterGarden`, release it, and only later acquire `closeGarden`. Migration never
upgrades `enterGarden` to `closeGarden`.

The migration callback's graph decisions are inputs used to derive the
migration-generated events; they are not an independent authority.

---

## 3. Migration journal result

Let `M` be the complete set of migration-generated journal events after
decisions, propagation, darkroom reconciliation, and content hashing.

```text
J1 = normalizeJournal(J0 ∪ M)
```

The destination's authoritative state is exactly `J1`. The target graph must be:

```text
G1 = projectGraph(newSchema, J1)
```

Before cutover require:

```text
migration-produced graph cache == G1
validateProjectedGraph(newSchema, J1, G1) succeeds
```

---

## 4. Target physical journal

Cursor validity across migration/schema boundaries remains outside the current
token contract, so the target need not copy all historical physical occurrences
or preserve old physical indices.

Construct the target physical journal from the final canonical journal `J1`:

- retain exactly one physical occurrence for each logical event in `J1`;
- an event copied from `J0` preserves its complete immutable payload, origin,
  and `eventId`, but receives a fresh target-local physical index;
- a new migration event uses the original physical/origin index reserved during
  its construction;
- an event removed by normalization need not be written;
- advance the root-local physical allocator monotonically;
- the complete destination remains invisible until cutover.

Copied old events are not new logical events: they preserve their `eventId`
(the content digest of their payload), so they carry the same logical identity.

---

## 5. Destination invisibility until cutover

The migration writes to an inactive destination replica:

- The complete inactive destination remains invisible to readers until the
  durable active-replica cutover succeeds.
- Failure before cutover leaves the previously active replica selected and
  unchanged.
- Each durable batch acquires the destination darkroom; the darkroom is not held
  for the complete potentially long-running migration.

Physical indices come from the single root-local allocator
(`incremental-graph-journal-types.md` § 2.1), shared by both replica slots. A
failed migration may advance the root-local allocator and leave gaps, but it
never permits reuse of a `(hostname, originIndex)` provenance tuple within the
same lineage.

---

## 6. Required traces

### Unchanged KEEP

```text
J0 contains state event S for K
migration KEEP K produces no event
M = {}
J1 = J0
projectGraph(newSchema, J1) contains K
```

The target must retain `S`; it must not contain cached `K` without `S`.

### Representation-only OVERRIDE

The logical assertion is unchanged:

```text
M = {}
J1 = J0
```

Only the rebuildable physical value representation changes.

### Edit

```text
J0 contains S1
migration produces edit S2 with greater state revision
J1 selects S2
```

### Proof-only change

```text
J0 contains state S and old freshness/proof assertion
migration produces freshness event F
J1 retains S and selects F
```

### Delete

```text
J0 contains S
migration produces delete T with greater state revision
J1 selects T
projectGraph does not materialize K
```

### Failure

A failed migration may consume allocator indices and leave inactive data, but:

```text
active canonical journal unchanged
active graph unchanged
active physical occurrences unchanged
active pointer unchanged
```

---

## 7. Failure guarantee

A failed migration leaves the active canonical journal, graph cache, and
physical occurrences of the previously active replica unchanged:

```text
failed migration:
    active canonical journal, active graph, active physical occurrences: unchanged
    root-local allocation watermark: may have advanced
```

The possible watermark advance is acceptable and required for uniqueness. A
retry of the failed migration, or any later host event, allocates indices
strictly above the failed attempt's last allocation. Entries and occurrences
written to the inactive destination before a failure are never activated.

---

## 8. Invariants

```text
A migration begins from the active canonical journal, not from an empty journal.
Migration result:
    J1 = normalizeJournal(J0 ∪ migrationEvents)
Migration target graph:
    projectGraph(newSchema, J1)
An unchanged KEEP may emit no event only because its existing canonical event is
carried into J1.
```
