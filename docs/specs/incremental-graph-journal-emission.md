# IncrementalGraph Journal Emission

## Purpose

This document specifies when journal entries are created — the rules for `add`,
`edit`, `delete`, `invalidate`, and `validate` emissions triggered by
IncrementalGraph operations and migration. Synchronization only copies,
repositions, or omits existing events.

Journal emission is always coordinated with the graph storage mutation that caused it: a journal entry MUST NOT be durably committed unless the corresponding graph change is also durably committed.

---

## Universal freshness-transition invariant

Every actual transition from `up-to-date` to `potentially-outdated` emits an
`invalidate` journal entry. Every actual transition from `potentially-outdated`
to `up-to-date` emits a `validate` journal entry. Operations that leave
freshness unchanged emit nothing.

This invariant applies to every system path that performs one of these
transitions: ordinary invalidation, cascading invalidation, migration
`storage.invalidate`, pull recomputation, and any other future path.
The source journal is therefore authoritative evidence of every freshness
transition for the current node incarnation.

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

REQ-JE-05: If a recomputation returns a value that is `isEqual` to the existing stored value, the system MUST NOT emit an `edit` entry. This includes cases where the computor explicitly returns the `Unchanged` sentinel and cases where the computor returns a value that happens to be deeply equal to the old value. However, if the node was `potentially-outdated` and transitions to `up-to-date`, the system MUST emit a `validate` entry.

#### Cache hit

REQ-JE-06: If a `pull` encounters an up-to-date node and returns its stored value without invoking the computor, the system MUST NOT emit a journal entry.

### Freshness transition: `invalidate`

REQ-JE-07: When a node's freshness changes from `up-to-date` to `potentially-outdated`, the system MUST emit a journal entry with `action: "invalidate"`. This transition may occur through:

- An explicit `invalidate(nodeName, bindings)` call.
- Cascading invalidation from an invalidated dependency.
- Any other system path that transitions a node's freshness from `up-to-date` to `potentially-outdated`.

REQ-JE-07a: The `invalidate` entry MUST be emitted in the same durable transaction as the freshness state change.

REQ-JE-07b: An `invalidate` entry is NOT a value change — it signals that the node's freshness has been downgraded. The node's stored value and `NodeIdentifier` are unchanged by this entry alone.

### Freshness transition: `validate`

REQ-JE-07c: When a node's freshness changes from `potentially-outdated` to `up-to-date`, the system MUST emit a journal entry with `action: "validate"`. This transition may occur through:

- A `pull(nodeName, bindings)` that recomputes a node and returns an unchanged value (recalculating does not change the value, but the freshness transition from `potentially-outdated` to `up-to-date` is a real event).
- A `pull(nodeName, bindings)` that recomputes a node and returns a changed value: this emits both an `edit` and a `validate` (see below for the ordering).
- Explicit validation paths that transition a node from `potentially-outdated` to `up-to-date` outside the ordinary pull path.

REQ-JE-07d: A `validate` entry is NOT a value change — it signals that the node's freshness has been restored. The node's stored value and `NodeIdentifier` are unchanged by this entry alone.

REQ-JE-07e: The `validate` entry MUST be emitted in the same durable transaction as the freshness state change.

REQ-JE-07f: When a recomputation changes a node's value, the system emits, in this order:

```
edit
validate
```

Both entries are committed in the same durable transaction as the new value, counter updates, and the freshness transition. Their indices are contiguous, with `edit` receiving the lower index and `validate` the higher index.

REQ-JE-07g: When a recomputation returns an unchanged value but the node was `potentially-outdated`, the system emits only `validate`. No `edit` is emitted.

REQ-JE-07h: When a `pull` encounters an up-to-date node (cache hit), the system MUST NOT emit `validate`. No freshness transition occurred.

REQ-JE-07i: When a node is materialized for the first time, the system emits only `add`. No `validate` is emitted because first materialization is not a transition from `potentially-outdated` to `up-to-date`.

REQ-JE-07j: Repeating an operation that leaves freshness unchanged emits nothing:
- `potentially-outdated → potentially-outdated`: emit nothing
- `up-to-date → up-to-date`: emit nothing

### Deletion: `delete`

REQ-JE-08: A `delete` journal entry represents an actual node deletion. The
following operation produces `delete` entries:

- **Actual deletion operations**: `storage.delete` and any future graph deletion
  operation emit a `delete` for the node they delete.

Synchronization may copy or reposition an existing `delete`; it never emits
one. See `incremental-graph-journal-sync.md`.

REQ-JE-09: Ordinary graph operations (`pull`, `invalidate`, recomputation) MUST NOT emit `delete` entries unless and until the IncrementalGraph system implements a general node deletion API. This specification does not assume such an API exists.

REQ-JE-10: Migration `storage.delete` MUST emit a `delete` journal entry for the deleted node. See `incremental-graph-journal-migrations.md` for the migration-specific rules.

### Migration actions

Migration actions have their own journal-emission rules, specified fully in `incremental-graph-journal-migrations.md`. In summary:

- `storage.create` produces an `add` journal entry.
- `storage.keep` produces no journal entry.
- `storage.override` produces no journal entry. It is a semantic-preserving representation rewrite that inherits freshness from the old record and does not propagate invalidation.
- `storage.delete` emits a `delete` journal entry for the deleted node (but does not remove older journal entries—see `incremental-graph-journal-migrations.md`).
- `storage.invalidate` produces an `invalidate` journal entry when it causes the target node's freshness to transition from `up-to-date` to `potentially-outdated`.

---

## Coordination with graph writes

REQ-JE-11: A journal entry MUST be written to durable storage in the same LevelDB batch as the graph-state writes it is associated with. A failed batch flush MUST leave both the graph state and the journal state unchanged.

REQ-JE-12: A successful batch flush MUST result in the journal entry being durably committed and the `last_journal_index` watermark being advanced (if the entry received a new index).

REQ-JE-13: The volatile journal state (in-memory next-index counter) MUST be updated only after the durable batch flush succeeds. This follows the established "disk before memory" invariant (see `docs/specs/incremental-graph-volatile-consistency.md`).

---

## Journal index allocation

JournalIndex allocation MUST happen during darkroom finalization, atomically with the durable batch commit. This ensures the published-prefix invariant (REQ-JT-17 through REQ-JT-18): once `last_journal_index = H` is published, no later ordinary append can ever fill, replace, or change a position at or below `H`.

REQ-JE-14: Each emitted journal entry MUST be assigned a unique, monotonically increasing `JournalIndex` during darkroom finalization, as part of the atomic durable batch that commits both the entry and the watermark. The index MUST be allocated strictly above the previously committed watermark. This mirrors the `NodeIdentifier` allocation pattern (see `docs/specs/incremental-graph-last-node-index.md`), with the critical difference that allocation is deferred until the commit point rather than being consumed at transaction start.

REQ-JE-15: A transaction MUST prepare unindexed journal entries during its unlocked body. Only once the transaction enters darkroom does it allocate a fresh contiguous range strictly above the current committed watermark, add those indexed entries and the new watermark to the same batch, and commit them atomically. This prevents the trace where one transaction allocates an index, a later transaction commits at a higher index and publishes the watermark, and the original transaction later fills a gap below the published watermark.

REQ-JE-16: Gaps in the journal index sequence are acceptable. They may be caused by:
- Compaction removing entries.
- Sync poisoning of divergent indices.
- Structural maintenance (poisoning or deleting entries while holding `closeGarden`).

Gaps caused by failed transactions are NOT possible under this allocation model, because index allocation occurs only during the durable commit, which either succeeds or fails atomically.

REQ-JE-17: The `last_journal_index` stored in `rendered/r/global/last_journal_index` is updated to the committed journal entry's index as part of the same atomic durable batch.

### JournalEventId assignment during first commit

REQ-JE-18: During darkroom finalization, after assigning the event its initial `JournalIndex` `i`, the implementation MUST compute the event's `JournalEventId` as:

```
const eventId = JSON.stringify([
    'journal-event-v1',
    hostnameToString(entry.creator),
    journalIndexToNumber(i),
]);
```

The entry, `eventId`, physical index `i`, graph mutation, and final watermark MUST be committed in the same atomic durable batch.

REQ-JE-19: For an existing event being replicated or reappended (not newly created), the implementation MUST NOT assign a new event ID. It MUST preserve the original `eventId` string unchanged. Only the physical storage position changes.

---

## Testing properties

The following properties MUST hold for a conforming implementation:

### P1 — Add on first pull

Pulling a previously unmaterialized node produces a journal entry with `action: "add"` and a `time` within the execution window of the pull.

### P2 — Edit on value change

Pulling a previously materialized node whose computor returns a different value (not `isEqual` to the old value) produces a journal entry with `action: "edit"`.

### P3 — No edit on unchanged; validate emitted when freshness transitions

Pulling a node whose computor returns `Unchanged` or a deeply-equal value produces no `edit` entry. If the node was `potentially-outdated` before recomputation and becomes `up-to-date`, the system emits a `validate` entry for the freshness transition.

### P4 — No entry on cache hit

Pulling an up-to-date node (cache hit) produces no new journal entry.

### P5 — Entry on freshness transition (invalidate)

Transitioning a node's freshness from `up-to-date` to `potentially-outdated` produces a journal entry with `action: "invalidate"`.

### P5a — Entry on freshness transition (validate)

Transitioning a node's freshness from `potentially-outdated` to `up-to-date` produces a journal entry with `action: "validate"`. This occurs when:
- An unchanged recomputation returns the existing value (only `validate` emitted).
- A changed recomputation emits `edit` and `validate` in that order (contiguous indices).
- A cache hit emits nothing (no freshness transition occurred).
- First materialization emits only `add` (first materialization is not a transition from `potentially-outdated`).

### P6 — Atomic journal+graph write

If a journal entry is visible (via `graph.possibleMaybeChanges`), the corresponding graph-state change must also be visible. If a graph-state write fails, no stale journal entry for it must be visible.

### P7 — Monotonic last_journal_index

After a sequence of journal-emitting operations, `last_journal_index` must be non-decreasing and must accurately reflect the greatest committed journal index.

### P8 — Failed transaction creates no gap

A failed journal-emitting transaction:
- publishes no entry;
- advances no watermark;
- consumes no journal index;
- creates no gap.

If a transaction prepares an unindexed entry, but then fails during darkroom finalization (or before), no trace of the failed entry remains in the journal index sequence.

### P9 — Event ID assigned atomically

A new ordinary or migration event assigned initial position `7` receives:

```
eventId = JSON.stringify(['journal-event-v1', hostnameToString(host), 7])
```

Entry, event ID, graph writes, and watermark `7` commit atomically. A reader that sees the entry at index 7 also sees its complete `eventId`. A reader that does not see index 7 sees no part of the event.

### P10 — Replication preserves event ID

An event reappended or replicated to another host retains its original `eventId` string unchanged. The `eventId` remains the same across all copies, even though the physical storage index differs.
