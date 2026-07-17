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

Preserves a node as-is in the new version. The node's value, freshness, inputs, revdeps, counters, and timestamps are copied unchanged.

REQ-JM-01: `storage.keep` MUST NOT create a journal entry. The node's pre-migration journal history (if any survives compaction) is preserved, but no new `PossibleNodeChange` is emitted for the migration-namespace transition.

Rationale: `keep` is a storage identity-preserving operation. The node's value and identity have not changed. Downstream consumers of the journal should not see a spurious change.

### `storage.override`

Replaces a node's value with a migration-supplied value.

REQ-JM-02: `storage.override` MUST NOT create a journal entry merely because storage was rewritten by the migration. The value change is a migration artifact, not a graph computation.

Rationale: `override` rewrites storage during a namespace transition. The old version's computed value is replaced by a migration-supplied value. This is a migration-level operation, not a graph-level edit. If the new value differs from the old value, the node will be recomputed on first `pull` in the new namespace (because override leaves nodes potentially-outdated), producing a regular `edit` journal entry at that time. The migration itself does not emit one.

### `storage.invalidate`

Marks a node for recomputation in the new version by setting its freshness to `potentially-outdated`.

REQ-JM-03: `storage.invalidate` MUST emit an `invalidate` journal entry when it causes a node in the target migrated state to transition from `up-to-date` to `potentially-outdated`. This mirrors REQ-JE-07 and REQ-JE-07b for runtime freshness transitions. If the node was already `potentially-outdated`, no journal entry is emitted (mirroring the same rule for runtime cascading invalidation).

### `storage.create`

Creates a new node (not present in the previous version) and assigns it an initial value.

REQ-JM-04: `storage.create` MUST create an `add` journal entry for the new node. This mirrors REQ-JE-01 for first materialization during normal graph operation.

REQ-JM-05: The `add` entry for a `storage.create` operation MUST be emitted in the same durable migration batch as the node's records. See REQ-JE-11 and REQ-JE-12.

### `storage.delete`

Removes a node from the new version entirely.

REQ-JM-06: `storage.delete` MUST emit a `delete` journal entry for the deleted node. The entry's `action` is `"delete"`, and its `time` and `creator` are set to the current migration time and local host respectively.

REQ-JM-07: `storage.delete` MUST NOT remove, purge, or otherwise modify any established journal entry for the deleted node (including older `add`, `edit`, or `invalidate` entries). The append-only rule applies: the `delete` entry is appended at a fresh index above the current watermark. Older journal entries for the deleted node remain until journal compaction removes them according to the compaction specification.

---

## Distinction from other change sources

The journal distinguishes migration-originated state from ordinary graph changes. Migration actions that change graph-observable state (`storage.create`, `storage.delete`, `storage.invalidate`) emit journal entries; identity-preserving operations (`storage.keep`, `storage.override`) do not:

| Operation | Journal effect | Reason |
|-----------|---------------|--------|
| `pull` (first materialization) | `add` entry | New graph node |
| `pull` (value change) | `edit` entry | Graph recomputation changed value |
| `invalidate` (standalone) | `invalidate` entry | Freshness transition |
| `storage.keep` | no entry | Identity-preserving copy |
| `storage.override` | no entry | Migration-level rewriting |
| `storage.invalidate` | `invalidate` entry | Freshness transition to `potentially-outdated` |
| `storage.create` | `add` entry | Intentional new node creation |
| `storage.delete` | `delete` entry | Node deleted by migration |
| Synchronization | existing events copied/reappended | Cross-host reconciliation (no new events created) |

---

## Atomicity

REQ-JM-08: Migration journal operations MUST be part of the migration's atomic batch. If the migration batch fails, no journal entries from migration actions (including `storage.create` `add` entries) must be visible in the journal.

REQ-JM-09: The `delete` journal entry emitted by `storage.delete` MUST be part of the same atomic migration batch. If the migration batch fails, the `delete` entry MUST NOT be visible in the journal.

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

Migration performs storage.create(B) and storage.invalidate(C).

After migration:
  index 4 = add B         (fresh entry, no gap between 3 and 4)
  index 5 = invalidate C  (fresh entry, only if C was up-to-date
                           and transitions to potentially-outdated)
  H = 5
```

Fresh migration-generated entries receive new commit-time indices above the inherited watermark.

### S3 — Migration cutover with reader

1. An existing `possibleMaybeChanges` reader completes on the old active replica before cutover.
2. Once `closeGarden` is queued, no new reader selects the old replica.
3. After cutover, new readers see the preserved journal prefix plus fresh migration entries.

The reader that started before cutover observes a consistent journal state of the old replica's journal. New readers observe the new replica's journal state (preserved prefix + migration appends).

Migration and replica cutover require exclusive access to both graph activity and the garden.

REQ-JM-10: Migration and replica cutover MUST acquire `holidayActivity` (graph activity exclusion) first, then `closeGarden` (garden exclusion), before performing any durable mutations. This follows the lock-ordering rule: acquire graph activity before garden access.

REQ-JM-11: For durable replica mutations during migration or cutover, the operation acquires darkroom inside the `closeGarden` scope, after both holiday and garden access have been acquired.

REQ-JM-12: Because `possibleMaybeChanges` holds `enterGarden` across replica selection and traversal, cutover waits for existing journal readers to leave. Once `closeGarden` is queued, no new reader can select the old replica during cutover.

---

## Out of scope

The interaction of stored journal tokens with schema-boundary invalidation is deferred to a future specification. This PR does not specify token validity across migration boundaries.
