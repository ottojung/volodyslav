# IncrementalGraph Journal Migrations

## Purpose

This document specifies how migration actions (as defined in `docs/specs/migration.md`) interact with the journal system — which actions create journal entries and which preserve existing journal state.

Migration operations are distinguished from ordinary graph changes and from synchronization conflict resolution. Migration acts at the storage level, rewriting graph state between schema versions. The journal must reflect intentional creation of new nodes but must not confuse storage-level rewriting with user-visible change events.

## Append-only rule

Migration MUST NOT delete, fill, replace, rewrite, poison, reinterpret, renumber, or otherwise modify an already established journal position.

Migration may only:

- preserve existing journal entries (byte-for-byte);
- preserve existing journal absences (presence-for-presence);
- append fresh journal entries at indices above the current committed watermark;
- advance `last_journal_index` atomically with those fresh entries.

This applies to every migration action, including `storage.delete`.

When migration builds a new replica, copying the old journal into the new replica is preservation, not a logical journal mutation. The new replica must contain the same established journal prefix as the old replica, followed by any freshly appended migration-generated entries.

Compaction, not migration, is responsible for later removal of redundant historical entries.

---

## Migration actions and journal behavior

### `storage.keep`

Preserves a node as-is in the new version. The node's value, freshness, inputs, revdeps, counters, and timestamps are copied unchanged. Because freshness is copied unchanged, keep never performs a freshness transition.

REQ-JM-01: `storage.keep` MUST NOT create a journal entry. It preserves existing journal history unchanged (subject to later compaction).

### `storage.override`

`storage.override` is a semantic-preserving representation rewrite. It may
change the stored representation (e.g., on-disk format) while preserving the
semantic value observed by dependents. It preserves freshness, timestamps, and
compatible validity from the old record and does not propagate invalidation.

Override is not a value change and not a freshness transition. It emits no
journal entry of any kind: not `add`, `edit`, `delete`, `invalidate`, or
`validate`.

REQ-JM-02: `storage.override` MUST NOT emit any journal entry. It preserves the
node's existing freshness unchanged.

| Prior freshness | Result freshness | Journal effect |
|---|---|---|
| `up-to-date` | `up-to-date` | no entry |
| `potentially-outdated` | `potentially-outdated` | no entry |

The migration-supplied value replaces the stored representation but preserves the
semantic value. The node's freshness is inherited from the old record.

### Pull behavior after override depends on inherited freshness

A subsequent pull is an ordinary graph operation, not a migration emission.

#### Override inherited up-to-date

```
before override: up-to-date
after override:  up-to-date
```

A subsequent pull is a cache hit:

- no recomputation;
- no `edit`;
- no `validate`;
- no journal entry.

#### Override inherited potentially outdated

```
before override: potentially-outdated
after override:  potentially-outdated
```

A subsequent pull recomputes normally:

- unchanged result → `validate`;
- changed result → `edit`, then `validate`;
- failed recomputation → no committed freshness restoration.

These later events are ordinary graph-operation events. Override itself emits
nothing in either case.

### `storage.invalidate`

Marks a node for recomputation in the new version by setting its freshness to `potentially-outdated`.

REQ-JM-03: `storage.invalidate` MUST emit an `invalidate` journal entry when it causes a node in the target migrated state to transition from `up-to-date` to `potentially-outdated`. This mirrors REQ-JE-07 and REQ-JE-07b for runtime freshness transitions. If the node was already `potentially-outdated`, no journal entry is emitted (mirroring the same rule for runtime cascading invalidation).

### `storage.create`

Creates a new node (not present in the previous version) and assigns it an initial value and freshness.

REQ-JM-04: `storage.create` MUST create an `add` journal entry for the new node. This mirrors REQ-JE-01 for first materialization during normal graph operation.

REQ-JM-04a: `storage.create` accepts an initial freshness of `"up-to-date"` or `"potentially-outdated"` (as defined in `docs/specs/migration.md`). The `add` entry carries no freshness event of its own — the initial freshness is recorded in the node's graph state, not as a journal entry. The `add` is the state/lifecycle entry; a freshness entry (`invalidate` or `validate`) is only emitted later by a real freshness transition.

REQ-JM-05: The `add` entry for a `storage.create` operation MUST be emitted in the same durable migration batch as the node's records. See REQ-JE-11 and REQ-JE-12.

### `storage.delete`

Removes a node from the new version entirely.

REQ-JM-06: `storage.delete` MUST emit a `delete` journal entry for the deleted node. The entry's `action` is `"delete"`, and its `time` and `creator` are set to the current migration time and local host respectively.

REQ-JM-07: `storage.delete` MUST NOT remove, purge, or otherwise modify any established journal entry for the deleted node (including older `add`, `edit`, `invalidate`, or `validate` entries). The append-only rule applies: the `delete` entry is appended at a fresh index above the current watermark. Older journal entries for the deleted node remain until journal compaction removes them according to the compaction specification.

---

## Distinction from other change sources

The journal distinguishes migration-originated state from ordinary graph changes. Migration actions that change graph-observable state (`storage.create`, `storage.delete`, `storage.invalidate`) emit journal entries; identity-preserving and semantic-preserving operations (`storage.keep`, `storage.override`) never emit journal entries:

| Operation | Journal effect | Reason |
|-----------|---------------|--------|
| `pull` (first materialization) | `add` entry | New graph node |
| `pull` (value change) | `edit` + `validate` entries | Graph recomputation changed value + freshness restored |
| `pull` (unchanged recomputation) | `validate` entry | Freshness restored, value unchanged |
| `invalidate` (standalone) | `invalidate` entry | Freshness downgrade |
| `storage.keep` | no entry | Identity-preserving copy |
| `storage.override` | no entry | Semantic-preserving representation rewrite; preserves freshness and does not emit a journal entry |
| `storage.invalidate` | conditional `invalidate` entry | Emitted only when freshness changes from `up-to-date` to `potentially-outdated`. An already potentially outdated node emits nothing. |
| `storage.create` | `add` entry | Intentional new node creation |
| `storage.delete` | `delete` entry | Node deleted by migration |
| Synchronization | existing events copied/reappended | Cross-host reconciliation (no new events created) |

---

## Durable coordination

Migration constructs an inactive replica through multiple durable writes. The
entire migration is not required to be one enormous database batch.

Two distinct guarantees apply:

1. **Emitted-event atomicity:** Every emitted journal event is committed in the
   same atomic durable batch as the graph and freshness mutation that caused
   it. No reader can observe one without the other.

2. **Destination invisibility until cutover:** The complete inactive destination
   remains invisible to readers until the durable active-replica cutover
   succeeds. Failure before cutover leaves the previous active replica selected
   and unchanged.

REQ-JM-08: While holding `holidayActivity` and `closeGarden`, the inactive
destination may be written through multiple durable batches. Each batch that
commits journal entries and associated graph records must keep them atomic with
one another. Each standard transaction finalization acquires the destination
darkroom. The darkroom may be acquired and released per durable batch; it is not
held for the complete potentially long-running migration.

REQ-JM-09: Journal indices and the destination watermark MUST remain internally
consistent at every intermediate state. `last_journal_index` must accurately
reflect every committed journal entry.

REQ-JM-10: All inactive-destination records — graph state, journal entries,
metadata, and watermark — MUST be durable before cutover. After all destination
records are durable and internally consistent, the finalization darkroom
finishes the remaining durable metadata and atomically switches the
active-replica pointer.

REQ-JM-11: No reader MUST observe the destination replica before cutover. The
inactive replica is not visible. Volatile active-replica state is published
only after the durable cutover succeeds.

REQ-JM-12: If migration fails before cutover, the old active replica MUST
remain selected and unchanged. The incomplete inactive replica may be discarded
or rebuilt.

---

## Testable scenarios

### S1 — Migration preserves journal history

```
Before migration:
  index 1 = add A    (last_journal_index = 1)

Migration performs storage.delete(A).

After migration:
  index 1 = same add A   (unchanged, byte-for-byte)
  index 2 = fresh delete A
  H = 2
```

No established position changes. The old `add` entry at index 1 is preserved exactly. Migration only appends the `delete` entry.

### S2 — Migration create and invalidate

```
Before migration:
  H = 3

Migration performs storage.create(B, ..., "up-to-date") and
storage.invalidate(C).

After migration:
  index 4 = add B         (fresh entry, no gap between 3 and 4)
  index 5 = invalidate C  (fresh entry, only if C was up-to-date
                           and transitions to potentially-outdated)
  H = 5
```

Fresh migration-generated entries receive new commit-time indices above the inherited watermark.

### S3 — Override preserves freshness

```
Before migration:
  node W is up-to-date
  H = 2

Migration performs storage.override(W):
  W's stored representation changes but semantic value and freshness are preserved.

After migration:
  W is up-to-date (freshness inherited from old record)
  H = 2 (no journal entry emitted)
```

Override emits no journal entry regardless of the prior freshness. The node retains
its inherited freshness — up-to-date before override stays up-to-date after,
potentially-outdated before stays potentially-outdated after. The later pull in the
new namespace is an ordinary graph operation, not a migration emission.

### S4 — Migration cutover with reader

1. An existing `possibleMaybeChanges` reader completes on the old active replica before cutover.
2. Once `closeGarden` is queued, no new reader selects the old replica.
3. After cutover, new readers see the preserved journal prefix plus fresh migration entries.

The reader that started before cutover observes a consistent journal state of the old replica's journal. New readers observe the new replica's journal state (preserved prefix + migration appends).

Migration and replica cutover require exclusive access to both graph activity and the garden.

REQ-JM-13: Migration and replica cutover MUST acquire `holidayActivity` (graph activity exclusion) first, then `closeGarden` (garden exclusion), before performing any durable mutations. This follows the lock-ordering rule: acquire graph activity before garden access.

REQ-JM-14: For durable replica mutations during migration or cutover, the operation acquires darkroom inside the `closeGarden` scope, after both holiday and garden access have been acquired.

REQ-JM-15: Because `possibleMaybeChanges` holds `enterGarden` across replica selection and traversal, cutover waits for existing journal readers to leave. Once `closeGarden` is queued, no new reader can select the old replica during cutover.

---

## Out of scope

The interaction of stored journal tokens with schema-boundary invalidation is deferred to a future specification. This PR does not specify token validity across migration boundaries.
