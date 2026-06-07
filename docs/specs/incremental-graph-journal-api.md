# IncrementalGraph Journal API

## Purpose

This document specifies the public journal query method `possibleMaybeChanges` on `IncrementalGraph`, its parameters, return semantics, ordering guarantees, and the initial-token convention.

See `docs/specs/incremental-graph-journal-types.md` for the `PossibleNodeChange`, `NodeFilter`, `JournalIndex`, and related type definitions.

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
     * @param {PossibleNodeChange} params.since - The cursor-like reference point.
     * @param {NodeFilter} params.to - Restricts results to nodes matching this filter.
     * @returns {AsyncIterator<PossibleNodeChange>}
     */
    async *possibleMaybeChanges({ since, to })
}
```

The name `possibleMaybeChanges` is the stable public API name. It MUST NOT be renamed. The method is called on an `IncrementalGraph` instance, e.g. `graph.possibleMaybeChanges(...)`.

### Parameters

**`since: PossibleNodeChange`**

A previously observed `PossibleNodeChange`, typically obtained from a prior call to `graph.possibleMaybeChanges` or from `baselinePossibleNodeChange()`.

The `since` value acts as a cursor: the returned iterator yields surviving matching entries strictly after the journal position referenced by `since`. The `since` value itself is NOT included in the returned iterator.

**`to: NodeFilter`**

Restricts the returned possible changes to nodes whose keys match the filter. See `docs/specs/incremental-graph-node-filter.md` for filter matching rules. `NodeFilter` values are constructed via `makeWildcard`, `makeGroundFilter`, and `makeUnionFilter`.

### Return value

`graph.possibleMaybeChanges` returns an `AsyncIterator<PossibleNodeChange>`. Each yielded value is a `PossibleNodeChange` that:

1. was recorded at a journal position strictly after the position referenced by `since`;
2. matches `to` according to `DEF-NF-MATCH-01`;
3. has public fields (`nodeName`, `bindings`, `action`, `time`) that accurately describe the change.

REQ-JA-01: The iterator MUST eventually terminate. It MUST NOT block indefinitely waiting for future changes.

---

## Ordering

REQ-JA-02: Returned `PossibleNodeChange` values MUST be yielded in ascending journal-index order (physical insertion order). This is equivalent to ascending `time` order for entries from the same host with a monotonic clock, but the authoritative ordering is journal-index order, not timestamp order.

REQ-JA-03: If multiple returned entries have equal timestamps, their relative order is still determined by journal-index order. Consumers MUST NOT depend on timestamp order for correctness.

---

## Missing and old journal entries

Journal storage may contain gaps because of compaction, reconciliation, failed transactions, or old tokens whose underlying entries have been removed. These gaps manifest as missing journal entries at certain `JournalIndex` values.

REQ-JA-04: `graph.possibleMaybeChanges` MUST skip absent journal entries. When scanning forward from `since`, missing indices MUST NOT cause errors or aborted iteration. The iterator silently advances past absent entries and yields the next surviving entry, if any. Compacted-away entries MUST NOT be reconstructed or re-yielded. If all matching entries strictly after `since` are absent, the iterator returns nothing.

REQ-JA-05: The safety of stored `since` tokens is carried by compaction (see `incremental-graph-journal-compaction.md` REQ-JC-13, REQ-JC-14). Compaction must not delete entries whose absence would make any stored token unsafe.

---

## Duplicate and conservative results

REQ-JA-06: The method MAY yield a `PossibleNodeChange` that describes a change which, after inspection by the consumer, turns out to be a no-op (e.g., a node computed to the same value, or an `edit` that did not alter the relevant consumer state). Consumers MUST be prepared to handle conservative results. The journal API is conservative in the sense that:

- Synchronization or compaction may cause a change to be reported more than once for the same node.
- A change may be reported even when the consumer's specific view of the node's value did not change.

This is intentional behavior. It is a design property that keeps the journal API tractable for incremental maintenance.

---

## Initial and baseline tokens

Callers following the typical computor pattern (see `incremental-graph-journal-computors.md`) need an initial `PossibleNodeChange` to pass as `since` on the first call.

REQ-JA-07: The system MUST expose a standalone function to obtain a baseline sentinel:

```js
/**
 * Return a sentinel PossibleNodeChange that represents a position
 * before any journal entry. When passed as `since` to
 * `graph.possibleMaybeChanges`, the graph returns all currently
 * available matching possible changes.
 *
 * @returns {PossibleNodeChange}
 */
function baselinePossibleNodeChange()
```

The returned value is a `BaselinePossibleNodeChange` (see `incremental-graph-journal-types.md`). It is NOT derived from a specific journal entry. Despite its type, the baseline sentinel does not represent a possible node change. Its only valid use is as a `since` argument. When passed to `graph.possibleMaybeChanges`, the graph treats it as a position before any committed journal entry and yields all currently available surviving journal-backed possible changes.

REQ-JA-08: `baselinePossibleNodeChange()` MUST be callable at any time. It MUST NOT require a prior call to `graph.possibleMaybeChanges`.

REQ-JA-09: `graph.possibleMaybeChanges({ since: baselinePossibleNodeChange(), to })` MUST return all currently available surviving journal-backed `PossibleNodeChange` values matching `to`. This produces every surviving journal entry whose node key matches the filter. It does not, by itself, enumerate current graph state unless compaction guarantees that at least one surviving journal entry exists for every materialized matching node (see REQ-JC-08).

### Convention: remember last yielded value

An alternative to `baselinePossibleNodeChange` is to remember the last `PossibleNodeChange` yielded in a previous full scan as the starting point for the next incremental call. This is the recommended pattern:

```js
// Journal-backed initialization
let lastChange = baselinePossibleNodeChange();
for await (const change of graph.possibleMaybeChanges({ since: lastChange, to: myFilter })) {
    // ... process change ...
    lastChange = change;
}
await storeCurrentToken(lastChange);

// ... later ...

// Incremental update
const since = await loadStoredToken();
for await (const change of graph.possibleMaybeChanges({ since, to: myFilter })) {
    // ... update only affected part ...
}
```

This pattern works because each `PossibleNodeChange` is also a valid `since` input. The consumer never needs to know about `JournalIndex` or underlying positioning mechanics.

---

## Concurrency

REQ-JA-10: `IncrementalGraph.prototype.possibleMaybeChanges` operates under the graph instance's `daytimeActivity(...)` (internally `withModeMutex(GRAPH_ACTIVITY_KEY, "daytime", ...)`). It may run concurrently with other daytime activities as allowed by the locking spec. It MUST NOT overlap with nighttime pull activity except as allowed by that spec. See `docs/specs/incremental-graph-locking-design.md`.

REQ-JA-11: The returned async iterator captures a snapshot of the journal state at the time of the call. New journal entries committed after the iterator is created MAY or MAY NOT be reflected in the iteration. This is implementation-defined, but the implementation MUST guarantee that the iterator is internally consistent: within one iterator over one observed span, the same surviving journal index MUST NOT be yielded twice, and no surviving journal index in the observed span may be skipped because of concurrent writes.
