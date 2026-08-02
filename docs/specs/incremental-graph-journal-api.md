# IncrementalGraph Journal API

## Purpose

This document specifies the public journal query method `possibleMaybeChanges` on `IncrementalGraph`, its parameters, return semantics, ordering guarantees, and the baseline-token convention.

This document specifies API behavior. It does not prescribe how an external client uses returned possible changes.

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

If `since` is `PossibleNodeChange`, the journal module looks up the token in
its private `WeakMap<PossibleNodeChange, CursorState>` and scans strictly
after its stored `index`.

**`to: NodeFilter`**

Restricts the returned possible changes to nodes whose keys match the filter. See `docs/specs/incremental-graph-node-filter.md` for filter matching rules. `NodeFilter` values are constructed via `makeWildcard`, `makeGroundFilter`, and `makeUnionFilter`.

### Return value

`graph.possibleMaybeChanges` returns `Promise<Array<PossibleNodeChange>>`. The returned array contains, for each matching semantic node key, at most its latest state entry (`add`, `edit`, or `delete`) and its latest freshness entry (`invalidate` or `validate`) from the logically compacted journal through the fixed bound `H`, provided those entries' journal indices are strictly greater than `since`.

REQ-JA-01: The returned array is finite. For each matching semantic node key, it contains at most its latest state entry and latest freshness entry from the logically compacted journal through the fixed bound `H`, provided their indices are strictly greater than `since`. Compacted-away entries are not reconstructed.

---

## Ordering

REQ-JA-02: Returned `PossibleNodeChange` values MUST be ordered by ascending journal index (physical insertion order).

REQ-JA-03: If multiple returned entries have equal timestamps, their relative order is still determined by journal-index order. No timestamp-order guarantee is provided; return ordering is determined by `JournalIndex`.

---

## Missing and old journal entries

Journal storage may contain gaps because of compaction, reconciliation, or other structural deletion. These gaps manifest as missing journal entries at certain `JournalIndex` values.

REQ-JA-04: `graph.possibleMaybeChanges` MUST skip absent journal entries. When scanning forward from `since`, missing indices MUST NOT cause errors or aborted iteration. Missing positions are skipped. The next surviving entry is considered for logical-view selection; it is returned only if it is the retained state or freshness entry for its semantic key and category.

---

## Multiple entries for the same node

`graph.possibleMaybeChanges` returns at most two `PossibleNodeChange` values per matching semantic node key: one state/lifecycle entry (`add`, `edit`, or `delete`) and one freshness entry (`invalidate` or `validate`). Older entries for the same key and category are logically suppressed even when still physically present.

Duplicate entries for the same key and category may exist physically. For
example, two overlapping invalidations may each commit an `invalidate` entry
(see `incremental-graph-journal-emission.md`). Logical compaction returns only
the latest retained entry per category; it does not return duplicates.

### Historical guarantee

Every returned `PossibleNodeChange` is derived from a real committed
`JournalEntry`. The journal never fabricates an event: an entry's immutable
payload is fixed at first durable commit, and one `eventId` never identifies two
different payloads.

Journal coverage has no false negatives for supported graph changes, but may
contain conservative or duplicate notifications. The action records the reason
or category under which the notification was originated. It is not an
exact-once assertion and does not assert current graph state.

A returned action does not necessarily prove that exactly one unique state
transition corresponding to that action occurred:

- A returned `add` was originated when the node became materialized.
- A returned `edit` was originated when the node's stored semantic value changed
  materially, or when notification coverage for a possible value change required
  an existing event.
- A returned `delete` was originated when an actual host-local deletion or
  unmaterialization transition occurred (`HostDeleteJournalEntry`), or by
  synchronization when the merged result does not materialize a key that at
  least one synchronized source materialized (`SyncDeleteJournalEntry`).
- A returned `invalidate` was originated when freshness transitioned to
  `potentially-outdated` (`HostInvalidateJournalEntry`), or by synchronization
  when the merged result is `potentially-outdated` for a key that at least one
  synchronized source considered `up-to-date`
  (`SyncInvalidateJournalEntry`).
- A returned `validate` was originated when successful recomputation restored an
  already materialized node's freshness to `up-to-date`.

Extra, duplicate, or redundant entries are permitted. Duplicate entries may
result from overlapping operations (for example, concurrent invalidations) or
from conservative synchronization notification. Logical compaction suppresses
redundant entries for query purposes, but a returned entry may still be one of
several occurrences of the same logical event.

### Current-state limitation

A returned event does not assert current graph state:

- A returned `add` does not prove the node is currently materialized.
- A returned `edit` does not prove that value is currently selected.
- A returned `delete` does not prove current unmaterialization.
- A returned `invalidate` does not prove current staleness.
- A returned `validate` does not prove current up-to-date freshness.

REQ-JA-09: No requirement in this specification depends on the external client
inspecting graph state after receiving a returned event. The returned array of
`PossibleNodeChange` values is the complete API result.

### Notification overapproximation

A `PossibleNodeChange` returned after `since` may be an older existing event
that synchronization repositioned to a newer physical journal position for
notification, or one of several conservative or duplicate notifications.

Therefore:

- appearing after `since` does not prove the event was originally emitted after
  `since`;
- the event's `time` remains its original provenance time;
- its `action` records the category under which the notification was originated;
- it does not assert that the same action happened locally during the latest
  synchronization;
- it does not assert current graph state.

The overapproximation must not be described as corruption, fabrication, or
invalid history. The event's immutable payload was fixed at first durable
commit, and the journal never invents events without a real committed entry.

Equivalent wording:

```
Journal events are immutable provenance records.
Journal queries are conservative change notifications.
```

### Coverage guarantee

Within the supported cursor domain (same-process session tokens), for semantic
keys matching the call's `to` filter, graph-observable changes have no false
negatives. Every matching key requiring notification is represented by a
retained entry positioned strictly after `since`, either as a newly originated
event or as a repositioned existing event.

REQ-JA-05: A returned `edit` is an existing journal event emitted by graph
recomputation and possibly copied or repositioned by synchronization. Migration
does not emit `edit`; synchronization may copy, reposition, or preserve an
existing edit. The presence of an `edit` entry does not guarantee that the
node's value materially changed; it provides notification coverage for a
possible value change.

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

**Note on freshness events and graph state:** A returned `validate` entry was
originated for a freshness transition to `up-to-date` (or provides notification
coverage for it). A returned freshness entry does not determine current graph
freshness.

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

### Empty results

An empty result does not advance the caller's position. When no matching
retained change is returned, the caller receives no newer cursor and therefore
retains its original `since` value. A later call with the same `since` may scan
the same unmatched suffix again. This is deliberate: the query returns only
matching `PossibleNodeChange` values, and re-scanning an unmatched suffix is
not a missing progress mechanism or a performance defect of the journal API.

---

## Initial and baseline tokens

A baseline position is the initial `since` value for the first query.

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

### Filter mutation

REQ-JA-CONC-06: The implementation may apply the `to` filter while the query is
running and may retain the references supplied to the filter at construction.
Mutating the filter or any structure reachable through it (its argument array,
its union branches, or nested `ConstValue` data) during or after an asynchronous
query is undefined behavior. The API provides no result-consistency guarantee for
a mutated filter. See `incremental-graph-node-filter.md`.
