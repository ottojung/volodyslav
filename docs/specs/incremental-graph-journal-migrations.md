# Incremental Graph Journal — Migrations

This document defines migrations as ordinary local entry emission. A migration
changes the graph schema or the installed graph state and emits the same
journal entries as any other graph operation.

---

## 1. Migration as ordinary emission

Migration-generated `add`, `edit`, `delete`, `invalidate`, and `validate`
entries follow the identical transition-to-entry matrix
(`incremental-graph-journal-emission.md` § Transition-to-entry matrix) and the
identical atomic batching discipline. There is no host-state version, no
operation ID, and no migration-specific journal semantics.

For example:

- `storage.create` of a node emits `add` carrying the complete materialization
  and its actual initial freshness;
- a value rewrite emits `edit`;
- an explicit `storage.invalidate` emits `invalidate`;
- a deletion emits `delete`;
- a revalidation emits `validate` for the current selected state event.

### Emitted-event atomicity

Every emitted journal entry is committed in the same atomic durable batch as
the graph-cache mutation and the freshness change that caused it. No reader can
observe one without the other.

---

## 2. Destination invisibility until cutover

The migration writes to an inactive destination replica:

- The complete inactive destination remains invisible to readers until the
  durable active-replica cutover succeeds.
- Failure before cutover leaves the previously active replica selected and
  unchanged.
- Each durable batch acquires the destination darkroom; the darkroom is not held
  for the complete potentially long-running migration.

`last local physical JournalIndex` must accurately reflect every committed
occurrence at every intermediate state.

---

## 3. Failure guarantee

A failed migration leaves both the graph cache and the physical occurrences of
the previously active replica unchanged. Entries and occurrences written to the
inactive destination before a failure are never activated.
