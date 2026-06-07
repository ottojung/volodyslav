# IncrementalGraph Journal Migrations

## Purpose

This document specifies how migration actions (as defined in `docs/specs/migration.md`) interact with the journal system — which actions create, preserve, or remove journal information.

Migration operations are distinguished from ordinary graph changes and from synchronization conflict resolution. Migration acts at the storage level, rewriting graph state between schema versions. The journal must reflect intentional creation of new nodes but must not confuse storage-level rewriting with user-visible change events.

---

## Migration actions and journal behavior

### `storage.keep`

Preserves a node as-is in the new version. The node's value, freshness, inputs, revdeps, counters, and timestamps are copied unchanged.

REQ-JM-01: `storage.keep` MUST NOT create a journal entry. The node's pre-migration journal history (if any survives compaction) is preserved, but no new `PossibleNodeChange` is emitted for the migration-namespace transition.

Rationale: `keep` is a storage identity-preserving operation. The node's value and identity have not changed. Journal consumers that have already processed this node should not see a spurious change.

### `storage.override`

Replaces a node's value with a migration-supplied value.

REQ-JM-02: `storage.override` MUST NOT create a journal entry merely because storage was rewritten by the migration. The value change is a migration artifact, not a graph computation.

Rationale: `override` rewrites storage during a namespace transition. The old version's computed value is replaced by a migration-supplied value. This is a migration-level operation, not a graph-level edit. If the new value differs from the old value, the node will be recomputed on first `pull` in the new namespace (because override leaves nodes potentially-outdated), producing a regular `edit` journal entry at that time. The migration itself does not emit one.

### `storage.invalidate`

Marks a node for recomputation in the new version.

REQ-JM-03: `storage.invalidate` MUST NOT create a journal entry. As with runtime `invalidate`, freshness transitions are not journaled events.

### `storage.create`

Creates a new node (not present in the previous version) and assigns it an initial value.

REQ-JM-04: `storage.create` MUST create an `add` journal entry for the new node. This mirrors REQ-JE-01 for first materialization during normal graph operation.

REQ-JM-05: The `add` entry for a `storage.create` operation MUST be emitted in the same durable migration batch as the node's records. See REQ-JE-11 and REQ-JE-12.

### `storage.delete`

Removes a node from the new version entirely.

REQ-JM-06: `storage.delete` MUST remove or purge journal information associated with the deleted node. Specifically:

- All journal entries for the deleted node's `NodeIdentifier` (in any journal sublevel) MAY be removed.
- Any pending or in-progress journal metadata referencing the node's `NodeIdentifier` MUST be cleaned up.

REQ-JM-07: `storage.delete` MUST NOT automatically emit a user-visible `delete` journal entry (with `action: "delete"`). Migration deletion is schema-level housekeeping, not a graph change that journal consumers need to observe.

Rationale: Migration deletions happen during version upgrades. The nodes being deleted belong to the old schema version and would not appear in `possibleMaybeChanges` queries scoped to the new schema version anyway. Emitting `delete` entries would create noise for journal consumers that operate across schema boundaries, which is not a supported use case for the initial journal design.

---

## Distinction from other change sources

The journal distinguishes migration-originated state from ordinary graph changes by keeping migration actions out of the normal emission path except for `storage.create`:

| Operation | Journal effect | Reason |
|-----------|---------------|--------|
| `pull` (first materialization) | `add` entry | New graph node |
| `pull` (value change) | `edit` entry | Graph recomputation changed value |
| `invalidate` (standalone) | no entry | Freshness change only |
| `storage.keep` | no entry | Identity-preserving copy |
| `storage.override` | no entry | Migration-level rewriting |
| `storage.invalidate` | no entry | Freshness change only |
| `storage.create` | `add` entry | Intentional new node creation |
| `storage.delete` | purge journal data | Schema-level removal |
| Sync conflict resolution | `delete` / `edit` entries | Cross-host reconciliation |

---

## Atomicity

REQ-JM-08: Migration journal operations MUST be part of the migration's atomic batch. If the migration batch fails, no journal entries from migration actions (including `storage.create` `add` entries) must be visible in the journal.

REQ-JM-09: Migration journal purges (`storage.delete` removing journal records) MUST also be part of the same atomic batch. Partial purge (some journal records removed, others left) in the event of a failure must not be observable.
