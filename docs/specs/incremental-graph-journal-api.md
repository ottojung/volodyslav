# IncrementalGraph Journal API

## Purpose

This document specifies the public journal query method `possibleMaybeChanges` on `IncrementalGraph`, its parameters, return semantics, ordering guarantees, and the baseline-token convention.

See `docs/specs/incremental-graph-journal-types.md` for the `PossibleNodeChange`, `BaselinePossibleNodeChange`, `NodeFilter`, `JournalIndex`, and related type definitions.

See `docs/specs/incremental-graph-node-filter.md` for the `NodeFilter` construction and matching specification.

---

## `IncrementalGraph.prototype.possibleMaybeChanges`

### Signature

```js
class IncrementalGraph {
    /**
     * Query possible node changes since a previously observed change,
     * restricted to nodes matching the given filter.
     *
     * @param {object} params
     * @param {PossibleNodeChange | BaselinePossibleNodeChange} params.since - The cursor-like reference point.
     * @param {NodeFilter} params.to - Restricts results to nodes matching this filter.
     * @returns {Promise<Array<PossibleNodeChange>>}
     */
    possibleMaybeChanges({ since, to })
}
```

The name `possibleMaybeChanges` is the stable public API name. It MUST NOT be renamed. The method is called on an `IncrementalGraph` instance, e.g. `graph.possibleMaybeChanges(...)`.

The API design intentionally uses `{ since, to }` as an object-parameter form rather than positional arguments. This is the settled signature shape.

### Parameters

**`since: PossibleNodeChange | BaselinePossibleNodeChange`**

A previously observed `PossibleNodeChange` (obtained from a prior call to `graph.possibleMaybeChanges`) or a `BaselinePossibleNodeChange` (obtained from `baselinePossibleNodeChange()`).

The `since` value acts as a cursor: the returned array contains surviving matching entries strictly after the journal position referenced by `since`. The `since` value itself is NOT included in the returned array.

If `since` is `BaselinePossibleNodeChange`, scanning starts from the first journal entry.

If `since` is `PossibleNodeChange`, the journal module widens it to `PrivatePossibleNodeChange` and scans strictly after its `index`.

**`to: NodeFilter`**

Restricts the returned possible changes to nodes whose keys match the filter. See `docs/specs/incremental-graph-node-filter.md` for filter matching rules. `NodeFilter` values are constructed via `makeWildcard`, `makeGroundFilter`, and `makeUnionFilter`.

### Return value

`graph.possibleMaybeChanges` returns `Promise<Array<PossibleNodeChange>>`. The returned array contains one `PossibleNodeChange` per surviving journal entry that:

1. was recorded at a journal position strictly after the position referenced by `since`;
2. matches `to` according to `DEF-NF-MATCH-01`;
3. has meaningful public fields (`nodeName`, `bindings`, `action`, `time`) that describe the change.

REQ-JA-01: The returned array is finite. It contains one value per surviving matching journal entry in the scanned span. Compacted-away entries are not reconstructed.

---

## Ordering

REQ-JA-02: Returned `PossibleNodeChange` values MUST be ordered by ascending journal index (physical insertion order).

REQ-JA-03: If multiple returned entries have equal timestamps, their relative order is still determined by journal-index order. Consumers MUST NOT depend on timestamp order for correctness.

---

## Missing and old journal entries

Journal storage may contain gaps because of compaction, reconciliation, or failed transactions. These gaps manifest as missing journal entries at certain `JournalIndex` values.

REQ-JA-04: `graph.possibleMaybeChanges` MUST skip absent journal entries. When scanning forward from `since`, missing indices MUST NOT cause errors or aborted iteration. The method silently advances past absent entries and includes the next surviving entry, if any, in the returned array. Compacted-away entries MUST NOT be reconstructed or included.

---

## Multiple entries for the same node

`graph.possibleMaybeChanges` returns one `PossibleNodeChange` per surviving journal entry that matches the filter. A single node key may appear in multiple journal entries — for example, the node's initial `add`, a later `edit` from recomputation, and an additional `edit` from sync reconciliation. Each journal entry produces its own `PossibleNodeChange`.

REQ-JA-05: A returned `edit` entry describes a graph change or sync reconciliation that produced a journal entry. The entry's presence does not guarantee that the node's value materially changed from the consumer's perspective. Consumers SHOULD re-check the current node value rather than assuming the entry describes a visible state transition.

---

## Initial and baseline tokens

Callers following the typical incremental pattern need an initial value to pass as `since` on the first call.

REQ-JA-06: The system MUST expose a standalone function to obtain a baseline position:

```js
/**
 * Return a position less than any real journal index.
 * When passed as `since` to `graph.possibleMaybeChanges`, the scan
 * starts from the first journal entry.
 *
 * @returns {BaselinePossibleNodeChange}
 */
function baselinePossibleNodeChange()
```

REQ-JA-07: `baselinePossibleNodeChange()` MUST be callable at any time. It MUST NOT require a prior call to `graph.possibleMaybeChanges`.

REQ-JA-08: `graph.possibleMaybeChanges({ since: baselinePossibleNodeChange(), to })` MUST return all currently available surviving journal-backed `PossibleNodeChange` values matching `to`. This returns a `PossibleNodeChange` for every surviving journal entry whose node key matches the filter.

---

## Concurrency

### Correctness requirement

REQ-JA-CONC-01: `possibleMaybeChanges({ since, to })` MUST observe a single consistent journal snapshot for one stable replica. There must exist a linearization point during the call such that the returned array is exactly:

- all surviving journal entries in that snapshot;
- whose journal index is strictly greater than the position referenced by `since`;
- whose node key matches `to`;
- ordered by ascending `JournalIndex`;
- projected to `PossibleNodeChange`.

No surviving journal index in the observed span is returned more than once, and no surviving matching journal index in the observed span is skipped.

### Sufficient implementation strategies

REQ-JA-CONC-02: A conforming implementation MAY satisfy REQ-JA-CONC-01 by holding the active replica's darkroom lock for the duration of the journal scan. This serializes the scan with all durable journal mutations, since every journal-writing operation commits through the darkroom lock.

REQ-JA-CONC-03: Alternatively, a conforming implementation MAY acquire a storage-level snapshot under the same serialization discipline and scan that snapshot without holding the darkroom lock for the full scan. The implementation may briefly acquire the relevant lock, capture a stable storage snapshot plus `last_journal_index`, release the lock, and scan the storage snapshot, provided the storage layer supports this correctly.

### Serialization discipline

REQ-JA-CONC-04: All journal structural mutations — append, delete, compact, poison, reappend, watermark update, migration journal mutation, and sync journal mutation — MUST be serialized with the journal snapshot mechanism used by `possibleMaybeChanges`.

REQ-JA-CONC-05: `possibleMaybeChanges` MUST read from a stable replica. Replica cutover MUST either be excluded while the journal snapshot is acquired or must provide a stable snapshot/handle for the selected replica.

### Snapshot coverage

The journal snapshot covers journal-relevant state only:

- active replica identity, or a stable handle to the chosen replica;
- `last_journal_index`;
- `rendered/r/journal/<index>` entries and absences;
- any volatile journal index/cache state used by the scan.

It does not need to cover:

- current graph values;
- freshness records except as already reflected by committed journal entries;
- revdeps;
- computor state;
- per-node pull locks;
- ordinary inspection reads.

Journal entries are committed atomically with their associated graph-state mutations, so the journal query only needs a consistent journal snapshot — not a snapshot of the entire graph database.
