# IncrementalGraph Journal API

## Purpose

This document specifies the public journal query method `possibleMaybeChanges` on `IncrementalGraph`, its parameters, return semantics, ordering guarantees, error behavior, and the initial-token convention.

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

A previously observed `PossibleNodeChange`, typically obtained from a prior call to `graph.possibleMaybeChanges` or from `graph.baselinePossibleNodeChange()`.

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

REQ-JA-06: Returned `PossibleNodeChange` values MUST be yielded in ascending journal-index order (physical insertion order). This is equivalent to ascending `time` order for entries from the same host with a monotonic clock, but the authoritative ordering is journal-index order, not timestamp order.

REQ-JA-07: If multiple returned entries have equal timestamps, their relative order is still determined by journal-index order. Consumers MUST NOT depend on timestamp order for correctness.

---

## Missing journal entries

Journal storage may contain gaps because of compaction, reconciliation, or failed transactions. These gaps manifest as missing journal entries at certain `JournalIndex` values.

REQ-JA-08: The method MUST skip absent journal entries. When scanning forward from `since`, missing indices MUST NOT cause errors or aborted iteration. The iterator silently advances past absent entries and yields the next surviving entry, if any.

REQ-JA-09: The method MUST NOT reconstruct, restore, or fabricate journal entries that have been deleted. Only surviving entries in the journal storage are yielded. If all matching entries after `since` are absent, the iterator returns nothing.

---

## Duplicate and conservative results

REQ-JA-10: The method MAY yield a `PossibleNodeChange` that describes a change which, after inspection by the consumer, turns out to be a no-op (e.g., a node computed to the same value, or an `edit` that did not alter the relevant consumer state). Consumers MUST be prepared to handle conservative results. The journal API is conservative in the sense that:

- Synchronization or compaction may cause a change to be reported more than once for the same node.
- A change may be reported even when the consumer's specific view of the node's value did not change.

This is not a bug. It is a design property that keeps the journal API tractable for incremental maintenance.

---

## Initial and baseline tokens

Callers following the typical computor pattern (see `incremental-graph-journal-computors.md`) need an initial `PossibleNodeChange` to pass as `since` on the first call.

REQ-JA-11: `IncrementalGraph` MUST expose a method to obtain a baseline `PossibleNodeChange` representing the "beginning of time" for the current replica's journal:

```js
class IncrementalGraph {
    /**
     * Return a sentinel PossibleNodeChange representing the earliest known journal state.
     * When passed as `since` to `graph.possibleMaybeChanges`, all available possible changes
     * matching the filter are returned.
     *
     * @returns {PossibleNodeChange}
     */
    baselinePossibleNodeChange()
}
```

The returned value represents the earliest journal position. It is NOT derived from a specific journal entry. It is a sentinel whose only valid use is as a `since` argument.

REQ-JA-12: `graph.baselinePossibleNodeChange()` MUST be callable at any time after the graph is opened.

REQ-JA-13: `graph.possibleMaybeChanges({ since: graph.baselinePossibleNodeChange(), to })` MUST return all currently available `PossibleNodeChange` values matching `to`.

### Convention: remember last yielded value

An alternative to `graph.baselinePossibleNodeChange` is to remember the last `PossibleNodeChange` yielded in a previous full scan as the starting point for the next incremental call. This is the recommended pattern:

```js
// First full computation
let lastChange = graph.baselinePossibleNodeChange();
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

## Behavior with old tokens

A stored `PossibleNodeChange` may become "old" relative to the journal state — entries between its position and the current journal head may have been compacted away.

REQ-JA-14: If `since` is old but the underlying journal entry still exists, the method MUST return all matching surviving entries between `since` and the current journal head.

REQ-JA-15: If the underlying journal entry for `since` has been compacted away, the method MUST skip the absent position and resume from the next surviving index strictly greater than the missing index.

REQ-JA-16: The method MUST NOT return compacted-away entries. If all surviving entries after the absent `since` position have also been compacted or do not match the filter, the iterator returns nothing. The safety obligation for stored tokens is carried by compaction (see `incremental-graph-journal-compaction.md` REQ-JC-11, REQ-JC-12), which must not delete entries whose absence would make any stored token unsafe.

---

## Concurrency

REQ-JA-17: `IncrementalGraph.prototype.possibleMaybeChanges` operates under the graph instance's `daytimeActivity(...)` (internally `withModeMutex(GRAPH_ACTIVITY_KEY, "daytime", ...)`). It MUST NOT block concurrent `pull` operations on the same graph instance indefinitely. See `docs/specs/incremental-graph-locking-design.md`.

REQ-JA-18: The returned async iterator captures a snapshot of the journal state at the time of the call. New journal entries committed after the iterator is created MAY or MAY NOT be reflected in the iteration. This is implementation-defined, but the implementation MUST guarantee that the iterator is internally consistent — no entry is seen twice or missed due to concurrent writes within the iterator's observed span.
