# IncrementalGraph Journal Migrations

## Purpose

This document specifies how migration actions (as defined in `docs/specs/migration.md`) interact with the journal system — which actions create, preserve, or remove journal information.

Migration operations are distinguished from ordinary graph changes and from synchronization conflict resolution. Migration acts at the storage level, rewriting graph state between schema versions. The journal must reflect intentional creation of new nodes but must not confuse storage-level rewriting with user-visible change events.

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

REQ-JM-07: After emitting the `delete` entry, `storage.delete` MUST also remove or purge other journal information associated with the deleted node's `NodeIdentifier`. Specifically:

- All journal entries for the deleted node's `NodeIdentifier` (in any journal sublevel) MAY be removed, **except** the `delete` entry itself which must survive.
- Any pending or in-progress journal metadata referencing the node's `NodeIdentifier` MUST be cleaned up.

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
| Sync conflict resolution | `delete` / `edit` entries | Cross-host reconciliation |

---

## Atomicity

REQ-JM-08: Migration journal operations MUST be part of the migration's atomic batch. If the migration batch fails, no journal entries from migration actions (including `storage.create` `add` entries) must be visible in the journal.

REQ-JM-09: The `delete` journal entry emitted by `storage.delete`, along with any removal of other journal records for the deleted node, MUST be part of the same atomic migration batch. Partial emission (entry written but other records not removed, or vice versa) in the event of a failure must not be observable.

---

## Out of scope

The interaction of stored journal tokens with schema-boundary invalidation is deferred to a future specification. This PR does not specify token validity across migration boundaries.
