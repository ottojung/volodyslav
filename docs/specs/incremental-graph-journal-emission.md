# IncrementalGraph Journal Emission

## Purpose

This document specifies when journal entries are created — the rules for `add`, `edit`, and `delete` emissions triggered by IncrementalGraph operations, synchronization, and migration.

Journal emission is always coordinated with the graph storage mutation that caused it: a journal entry MUST NOT be durably committed unless the corresponding graph change is also durably committed.

---

## Emission triggers

### First materialization: `add`

REQ-JE-01: When a node becomes materialized for the first time (i.e., a new `NodeIdentifier` is allocated and the node's value is written to storage), the system MUST emit a journal entry with `action: "add"`.

First materialization occurs during:

- A `pull(nodeName, bindings)` call for a previously unmaterialized node.
- A migration `storage.create(nodeKey, value)` call that allocates a fresh `NodeIdentifier`.

REQ-JE-02: The `add` entry MUST be emitted in the same durable transaction as the node's identifier allocation, value write, and identifier-lookup insertion. If any part of that transaction fails, the journal entry MUST NOT be committed.

### Value change: `edit`

REQ-JE-03: When a node's stored value changes materially (i.e., the new computed value is not `isEqual` to the old stored value), the system MUST emit a journal entry with `action: "edit"`.

REQ-JE-04: The `edit` entry MUST be emitted in the same durable transaction as the value write and counter increment.

#### Unchanged recomputation

REQ-JE-05: If a recomputation returns a value that is `isEqual` to the existing stored value, the system MUST NOT emit a journal entry. This includes cases where the computor explicitly returns the `Unchanged` sentinel and cases where the computor returns a value that happens to be deeply equal to the old value.

#### Cache hit

REQ-JE-06: If a `pull` encounters an up-to-date node and returns its stored value without invoking the computor, the system MUST NOT emit a journal entry.

#### Invalidation

REQ-JE-07: An `invalidate` call that does not produce a new value (i.e., standalone invalidation without an immediate recomputation) MUST NOT emit a journal entry. Journal entries reflect value changes and materialization, not freshness transitions.

### Deletion: `delete`

REQ-JE-08: A `delete` journal entry represents the removal or supersession of a node. The following circumstances produce `delete` entries:

- **Synchronization conflict resolution**: When two hosts allocate conflicting node identifiers for the same node key, the losing identifier is de-materialized. The system MUST emit a `delete` journal entry for the losing identifier's node key. See `incremental-graph-journal-sync.md`.

- **Synchronization key disappearance**: When a remote host has deleted a node that the local host has materialized, the local host MUST emit a `delete` journal entry for that node key after reconciliation. See `incremental-graph-journal-sync.md`.

REQ-JE-09: Ordinary graph operations (`pull`, `invalidate`, recomputation) MUST NOT emit `delete` entries unless and until the IncrementalGraph system implements a general node deletion API. This specification does not assume such an API exists.

REQ-JE-10: Migration `storage.delete` does NOT automatically mean an emitted `delete` journal entry. See `incremental-graph-journal-migrations.md` for the migration-specific rules.

### Migration actions

Migration actions have their own journal-emission rules, specified fully in `incremental-graph-journal-migrations.md`. In summary:

- `storage.create` produces an `add` journal entry.
- `storage.keep` produces no journal entry.
- `storage.override` produces no journal entry.
- `storage.delete` removes journal information for the deleted node; it does not automatically emit a user-visible `delete` event.
- `storage.invalidate` produces no journal entry (same reasoning as runtime invalidation).

---

## Coordination with graph writes

REQ-JE-11: A journal entry MUST be written to durable storage in the same LevelDB batch as the graph-state writes it is associated with. A failed batch flush MUST leave both the graph state and the journal state unchanged.

REQ-JE-12: A successful batch flush MUST result in the journal entry being durably committed and the `last_journal_index` watermark being advanced (if the entry received a new index).

REQ-JE-13: The volatile journal state (in-memory next-index counter, in-memory index-to-position mapping) MUST be updated only after the durable batch flush succeeds. This follows the established "disk before memory" invariant (see `docs/specs/incremental-graph-volatile-consistency.md`).

---

## Journal index allocation

REQ-JE-14: Each emitted journal entry MUST be assigned a unique, monotonically increasing `JournalIndex` at allocation time. The index is allocated from the volatile next-index counter, following the same pattern as `NodeIdentifier` allocation (see `docs/specs/incremental-graph-last-node-index.md`).

REQ-JE-15: Gaps in the journal index sequence are acceptable (caused by failed transactions that consumed an index but did not commit).

REQ-JE-16: The `last_journal_index` stored in `rendered/r/global/last_journal_index` is updated to the committed journal entry's index as part of the durable batch.

---

## Testing properties

The following properties MUST hold for a conforming implementation:

### P1 — Add on first pull

Pulling a previously unmaterialized node produces a journal entry with `action: "add"` and a `time` within the execution window of the pull.

### P2 — Edit on value change

Pulling a previously materialized node whose computor returns a different value (not `isEqual` to the old value) produces a journal entry with `action: "edit"`.

### P3 — No entry on unchanged

Pulling a node whose computor returns `Unchanged` or a deeply-equal value produces no new journal entry.

### P4 — No entry on cache hit

Pulling an up-to-date node (cache hit) produces no new journal entry.

### P5 — No entry on standalone invalidate

Calling `invalidate` without a subsequent `pull` produces no new journal entry.

### P6 — Atomic journal+graph write

If a journal entry is visible (via `possibleMaybeChanges`), the corresponding graph-state change must also be visible. If a graph-state write fails, no stale journal entry for it must be visible.

### P7 — Monotonic last_journal_index

After a sequence of journal-emitting operations, `last_journal_index` must be non-decreasing and must accurately reflect the greatest committed journal index.
