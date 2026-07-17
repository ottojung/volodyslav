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

`graph.possibleMaybeChanges` returns `Promise<Array<PossibleNodeChange>>`. The returned array contains, for each matching semantic node key, at most its latest state entry (`add`, `edit`, or `delete`) and its latest freshness entry (`invalidate` or `validate`) from the logically compacted journal through the fixed bound `H`, provided those entries' journal indices are strictly greater than `since`.

REQ-JA-01: The returned array is finite. For each matching semantic node key, it contains at most its latest state entry and latest freshness entry from the logically compacted journal through the fixed bound `H`, provided their indices are strictly greater than `since`. Compacted-away entries are not reconstructed.

---

## Ordering

REQ-JA-02: Returned `PossibleNodeChange` values MUST be ordered by ascending journal index (physical insertion order).

REQ-JA-03: If multiple returned entries have equal timestamps, their relative order is still determined by journal-index order. Consumers MUST NOT depend on timestamp order for correctness.

---

## Missing and old journal entries

Journal storage may contain gaps because of compaction, reconciliation, or other structural deletion. These gaps manifest as missing journal entries at certain `JournalIndex` values.

REQ-JA-04: `graph.possibleMaybeChanges` MUST skip absent journal entries. When scanning forward from `since`, missing indices MUST NOT cause errors or aborted iteration. The method silently advances past absent entries and includes the next surviving entry, if any, in the returned array. Compacted-away entries MUST NOT be reconstructed or included.

---

## Multiple entries for the same node

`graph.possibleMaybeChanges` returns at most two `PossibleNodeChange` values per matching semantic node key: one state/lifecycle entry (`add`, `edit`, or `delete`) and one freshness entry (`invalidate` or `validate`). Older entries for the same key and category are logically suppressed even when still physically present.

REQ-JA-05: A returned `edit` entry describes a graph change or sync reconciliation that produced a journal entry. The entry's presence does not guarantee that the node's value materially changed from the consumer's perspective. Consumers SHOULD re-check the current node value rather than assuming the entry describes a visible state transition.

---

## Normative semantics

The normative conceptual order for `possibleMaybeChanges` is:

1. `enterGarden` → select active replica → read fixed `H = last_journal_index`
2. Construct `logicalJournalView(journal, H)` — logically compact first through the complete prefix
3. Restrict to entries whose journal index is strictly greater than `since`
4. Apply `NodeFilter` to the retained entries
5. Order by ascending `JournalIndex`
6. Project to `PossibleNodeChange`
7. Leave garden and return the finite array

The defining property is:

```
logically compact first
then apply the cursor
```

not:

```
iterate raw physical entries after the cursor
```

### Exact result contract

For every semantic node key matching `to`, the query returns at most:

- its latest state entry (`add`, `edit`, or `delete`) through `H`, if that entry's index is greater than `since`;
- its latest freshness entry (`invalidate` or `validate`) through `H`, if that entry's index is greater than `since`.

The final array is sorted by ascending physical `JournalIndex`.

REQ-JA-01a: `possibleMaybeChanges` MUST NOT return entries whose action is `add`, `edit`, or `delete` when a later-index entry of the same category exists for the same semantic key through `H`. The latest state entry per key is returned; older state entries within the prefix are suppressed by logical compaction.

REQ-JA-01b: `possibleMaybeChanges` MUST NOT return entries whose action is `invalidate` or `validate` when a later-index entry of the same category exists for the same semantic key through `H`. The latest freshness entry per key is returned; older freshness entries within the prefix are suppressed by logical compaction.

### Equivalent implementation

The implementation does not need to scan entries before `since`. For each key and category:

- If the retained winner through `H` is greater than `since`, it is also the greatest-index entry in that category within `(since, H]`;
- If no entry in that category exists in `(since, H]`, the retained winner is not returned.

Therefore an implementation may scan only `(since, H]` and retain, per matching semantic key:

- greatest-index `add | edit | delete`;
- greatest-index `invalidate | validate`.

This is an optimization equivalence.

The normative meaning remains logical compaction through `H`, followed by cursor restriction.

### Cursor semantics

The logical winner is selected through the complete fixed prefix ending at `H`. It is returned only when its retained index is greater than `since`.

Example:

```
index 2 = add X
index 5 = edit X
index 8 = edit X
index 10 = invalidate X
index 12 = validate X
```

For a baseline query through `H = 12`, return:

```
index 8  = edit X
index 12 = validate X
```

Do not return indices 2, 5, or 10, even if they still physically exist.

For `since = index 6, H = 12`, return the same two entries:

```
index 8  = edit X
index 12 = validate X
```

For `since = index 9, H = 12`, return only:

```
index 12 = validate X
```

For `since = index 12, H = 12`, return neither entry for X.

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

REQ-JA-08: `graph.possibleMaybeChanges({ since: baselinePossibleNodeChange(), to })` MUST return the `PossibleNodeChange` values for every matching semantic node key's latest state entry and latest freshness entry from the logical journal view through the fixed bound `H`. This yields at most two entries per matching key.

---

## Concurrency

### Correctness requirement

REQ-JA-CONC-01: `possibleMaybeChanges({ since, to })` MUST observe a consistent journal state through shared garden access. There must exist a linearization point during the call such that the returned array is exactly the result of:

1. Constructing `logicalJournalView` through the captured bound `H`;
2. Restricting to entries whose journal index is strictly greater than the position referenced by `since`;
3. Applying `NodeFilter`;
4. Ordering by ascending `JournalIndex`;
5. Projecting to `PossibleNodeChange`.

The returned array contains, for each matching semantic node key: at most its latest state entry and its latest freshness entry through `H`, when those entries' indices exceed `since`.

### Shared garden access

REQ-JA-CONC-02: `possibleMaybeChanges` MUST call `enterGarden` to acquire shared garden access before selecting the active replica. The query holds `enterGarden` for the entire scan.

REQ-JA-CONC-03: The linearization point is the read of `last_journal_index = H` after entering the garden. At that point:

- Structural changes (compaction, structural sync) are excluded by shared garden access. Migration and replica cutover are also excluded (they close the garden for lifecycle safety, preventing readers from traversing a replica while it is being replaced).
- Every position at or below `H` is finalized with respect to ordinary append-only operations (see the published-prefix invariant in `incremental-graph-journal-types.md`).
- Later ordinary appends receive indices greater than `H` and are outside this query.

### Journal state coverage

The consistent journal state covers journal-relevant state only:

- active replica identity (stable because garden access excludes replica cutover);
- `last_journal_index`;
- `rendered/r/journal/<index>` entries and absences.

It does not need to cover:

- current graph values;
- freshness records except as already reflected by committed journal entries;
- revdeps;
- computor state;
- per-node pull locks;
- ordinary inspection reads.

Journal entries are committed atomically with their associated graph-state mutations, so the journal query only needs a consistent journal state — not a consistent state of the entire graph database.

### What is not blocked

REQ-JA-CONC-04: `possibleMaybeChanges` does not acquire the graph activity mode lock or the darkroom lock. Ordinary daytime and nighttime graph operations, including ordinary append-only journal growth, may overlap with journal queries.

### Replica cutover serialization

REQ-JA-CONC-05: Replica cutover is serialized with journal queries through the garden. Replica cutover acquires `holidayActivity` and then `closeGarden`. Because `possibleMaybeChanges` holds `enterGarden` across replica selection and traversal, cutover waits for existing journal readers to leave. Once `closeGarden` is queued, new readers do not overtake it. No new reader can select the old replica during cutover.
