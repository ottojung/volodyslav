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

Migration compares the **complete journal-projected assertion** — value,
logically relevant identifier and timestamps, stored freshness, and the input
proof map under the new schema — not merely observable value and freshness. A
migration operation may emit nothing only when the resulting authoritative
assertion is unchanged.

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

## 2. Destination invisibility until cutover

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
never permits reuse of a `(hostname, originIndex)` tuple.

---

## 3. Failure guarantee

A failed migration leaves both the graph cache and the physical occurrences of
the previously active replica unchanged:

```text
failed migration:
    active graph, active logical journal, active physical occurrences: unchanged
    root-local allocation watermark: may have advanced
```

The possible watermark advance is acceptable and required for uniqueness. A
retry of the failed migration, or any later host event, allocates indices
strictly above the failed attempt's last allocation. Entries and occurrences
written to the inactive destination before a failure are never activated.
