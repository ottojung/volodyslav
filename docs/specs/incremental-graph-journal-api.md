# IncrementalGraph Journal API

## Purpose

This document specifies the public journal query interface `possibleMaybeChanges`, its parameters, return semantics, ordering guarantees, error behavior, and the initial-token convention.

See `docs/specs/incremental-graph-journal-types.md` for the `PossibleNodeChange`, `NodeFilter`, `JournalIndex`, and related type definitions.

See `docs/specs/incremental-graph-node-filter.md` for the `NodeFilter` construction and matching specification.

---

## possibleMaybeChanges

### Signature

```js
/**
 * Query possible node changes since a previously observed change,
 * restricted to nodes matching the given filter.
 *
 * @param {object} params
 * @param {PossibleNodeChange} params.since - The cursor-like reference point.
 * @param {NodeFilter} params.to - Restricts results to nodes matching this filter.
 * @returns {AsyncIterator<PossibleNodeChange>}
 */
async function* possibleMaybeChanges({ since, to })
```

The name `possibleMaybeChanges` is the stable public API name. It MUST NOT be renamed.

### Parameters

**`since: PossibleNodeChange`**

A previously observed `PossibleNodeChange`, typically obtained from a prior call to `possibleMaybeChanges` or from a baseline initialization operation.

The `since` value acts as a cursor: the returned iterator yields possible changes that were recorded at or after the position of `since`. The `since` value itself is NOT included in the returned iterator.

REQ-JA-01: If `since` is not a valid `PossibleNodeChange` (as determined by `isPossibleNodeChange`), `possibleMaybeChanges` MUST throw an error.

REQ-JA-02: If `since` refers to a journal position that no longer exists (e.g., it has been compacted away), `possibleMaybeChanges` MUST NOT throw. It MUST treat the missing position conservatively and yield any possible changes that could have occurred after the earliest still-available position that is definitely at or after `since`.

**`to: NodeFilter`**

Restricts the returned possible changes to nodes whose keys match the filter. See `docs/specs/incremental-graph-node-filter.md` for filter matching rules.

REQ-JA-03: If `to` is not a valid `NodeFilter` (as determined by `isNodeFilter`), `possibleMaybeChanges` MUST throw an error.

### Return value

`possibleMaybeChanges` returns an `AsyncIterator<PossibleNodeChange>`. Each yielded value is a `PossibleNodeChange` that:

1. was recorded at a journal position at or after `since`;
2. matches `to` according to `DEF-NF-MATCH-01`;
3. has public fields (`nodeName`, `bindings`, `action`, `time`) that accurately describe the change.

REQ-JA-04: The iterator MUST NOT yield the `since` value itself.

REQ-JA-05: The iterator MUST eventually terminate. It MUST NOT block indefinitely waiting for future changes.

---

## Ordering

REQ-JA-06: Returned `PossibleNodeChange` values MUST be yielded in ascending journal-index order (physical insertion order). This is equivalent to ascending `time` order for entries from the same host with a monotonic clock, but the authoritative ordering is journal-index order, not timestamp order.

REQ-JA-07: The ordering guarantee is best-effort with respect to `time`: entries with equal `time` values (possible when clocks are coarse or across hosts during sync) are ordered arbitrarily within their shared index position. Consumers MUST NOT depend on strict timestamp ordering for correctness.

---

## Missing journal entries

Journal storage may contain gaps because of compaction or reconciliation. These gaps manifest as missing journal entries at certain `JournalIndex` values.

REQ-JA-08: `possibleMaybeChanges` MUST tolerate missing journal entries. When scanning forward from `since`, gaps in the journal index sequence MUST NOT cause errors, aborted iteration, or skipped results beyond the gap.

REQ-JA-09: When the `since` value maps to a `JournalIndex` that has been compacted away, the implementation MUST safely resume from the earliest available index that is definitely at or after the position of `since`. This means the implementation must retain enough metadata (or use index-position heuristics) to determine a safe restart point. See `incremental-graph-journal-compaction.md`.

---

## Duplicate and conservative results

REQ-JA-10: `possibleMaybeChanges` MAY yield a `PossibleNodeChange` that describes a change which, after inspection by the consumer, turns out to be a no-op (e.g., a node computed to the same value, or an `edit` that did not alter the relevant consumer state). Consumers MUST be prepared to handle conservative results. The journal API is conservative in the sense that:

- Synchronization or compaction may cause a change to be reported more than once for the same node.
- A change may be reported even when the consumer's specific view of the node's value did not change.

This is not a bug. It is a design property that keeps the journal API tractable for incremental maintenance.

---

## Initial and baseline tokens

Callers following the typical computor pattern (see `incremental-graph-journal-computors.md`) need an initial `PossibleNodeChange` to pass as `since` on the first call.

REQ-JA-11: The journal system MUST provide a way to obtain a baseline `PossibleNodeChange` representing the "beginning of time" for the current replica's journal. The exact mechanism is:

```js
/**
 * Return a sentinel PossibleNodeChange representing the earliest known journal state.
 * When passed as `since` to `possibleMaybeChanges`, all available possible changes
 * matching the filter are returned.
 *
 * @returns {PossibleNodeChange}
 */
function baselinePossibleNodeChange()
```

The returned value represents the earliest journal position. It is NOT derived from a specific journal entry. It is a sentinel whose only valid use is as a `since` argument.

REQ-JA-12: `baselinePossibleNodeChange()` MUST be callable at any time after the journal is initialized. It MUST NOT require a prior call to `possibleMaybeChanges`.

REQ-JA-13: `possibleMaybeChanges({ since: baselinePossibleNodeChange(), to })` MUST return all currently available `PossibleNodeChange` values matching `to`.

### Convention: remember last yielded value

An alternative to `baselinePossibleNodeChange` is to remember the last `PossibleNodeChange` yielded in a previous full scan as the starting point for the next incremental call. This is the recommended pattern:

```js
// First full computation
let lastChange = baselinePossibleNodeChange();
for await (const change of possibleMaybeChanges({ since: lastChange, to: myFilter })) {
    // ... process change ...
    lastChange = change;
}
await storeCurrentToken(lastChange);

// ... later ...

// Incremental update
const since = await loadStoredToken();
for await (const change of possibleMaybeChanges({ since, to: myFilter })) {
    // ... update only affected part ...
}
```

This pattern works because each `PossibleNodeChange` is also a valid `since` input. The consumer never needs to know about `JournalIndex` or underlying positioning mechanics.

---

## Behavior with old tokens

A stored `PossibleNodeChange` may become "old" relative to the journal state — entries between its position and the current journal head may have been compacted away.

REQ-JA-14: If `since` is old but still valid (not all intermediate entries have been compacted away), `possibleMaybeChanges` MUST return all matching possible changes between `since` and the current journal head.

REQ-JA-15: If `since` is so old that ALL matching entries between it and the current journal head have been compacted away, the implementation MAY return a subset of possible changes or an empty iterator. It MUST NOT return incorrect results that omit changes known to be present.

REQ-JA-16: If compaction makes it impossible to determine what happened between `since` and the current head, `possibleMaybeChanges` SHOULD conservatively return ALL currently available matching changes (i.e., treat it like a baseline query). This ensures that consumers at least see everything, even if they may re-process entries they have already seen.

---

## Concurrency

REQ-JA-17: `possibleMaybeChanges` operates under the `observe` locking mode (see `docs/specs/incremental-graph-locking-design.md`). It MUST NOT block concurrent `pull` operations indefinitely.

REQ-JA-18: The returned async iterator captures a snapshot of the journal state at the time of the call. New journal entries committed after the iterator is created MAY or MAY NOT be reflected in the iteration. This is implementation-defined, but the implementation MUST guarantee that the iterator is internally consistent — no entry is seen twice or missed due to concurrent writes within the iterator's observed span.
