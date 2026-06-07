# IncrementalGraph Journal Computors

## Purpose

This document specifies how computors (graph computation functions) should use the journal to maintain derived state incrementally.

The journal enables incremental maintenance for computors with open-ended dependencies — cases where a computor depends on a family of nodes (e.g., all nodes with a given head or matching a pattern) and cannot statically enumerate its inputs.

This document uses normative language for requirements on journal-using computors and provides non-normative examples for illustration.

---

## The computor journal pattern

A journal-using computor follows this lifecycle:

1. **Journal-backed initialization**: On first run (or when no prior token is available), initialize derived state from surviving journal entries. Start from the baseline sentinel (`BaselinePossibleNodeChange`). Each value yielded by the iterator is a `PossibleNodeChange`. Store the last `PossibleNodeChange` seen during the scan.
2. **Incremental update**: On subsequent runs, call `graph.possibleMaybeChanges` with the stored `PossibleNodeChange` and an appropriate `NodeFilter`. Update only the affected portion of derived state.
3. **Store token**: After processing, store the last `PossibleNodeChange` from the scan for use as the next `since` value.

---

## Pattern in detail

### Step 1: Journal-backed initialization

A computor initializes its derived state from the journal by starting from the baseline sentinel and processing every surviving matching journal entry:

```js
// Journal-backed initialization
// lastChange starts as BaselinePossibleNodeChange; values from the iterator
// are always PossibleNodeChange, so lastChange becomes PossibleNodeChange
// after the first iteration.
let lastChange = baselinePossibleNodeChange();
for await (const change of graph.possibleMaybeChanges({
    since: lastChange,
    to: myFilter,
})) {
    await updateDerivedState(change);
    lastChange = change;
}
await storeToken("my-computor-state", lastChange);
```

The `baselinePossibleNodeChange()` call provides a `BaselinePossibleNodeChange` sentinel that causes `graph.possibleMaybeChanges` to return all surviving matching journal entries. Each yielded value is a `PossibleNodeChange` with meaningful `nodeName`, `bindings`, `action`, and `time` fields. The computor processes each change and remembers the last one.

**Important**: This initialization walks surviving journal entries, not the full set of currently materialized nodes. Its correctness depends on compaction preserving at least one surviving add/edit entry for every materialized matching node (see REQ-JC-08). If a true full enumeration of current graph state is required — for example, when a computor's derived state depends on every currently materialized node and cannot trust the journal to contain an entry for each — the computor SHOULD enumerate graph state directly (e.g., via a graph enumeration API) rather than relying solely on `possibleMaybeChanges` with the baseline sentinel.

### Step 2: Incremental update

```js
// Subsequent run
const since = await loadToken("my-computor-state");
for await (const change of graph.possibleMaybeChanges({
    since,
    to: myFilter,
})) {
    await updateDerivedState(change);
    // Optionally update the token progressively
    // (or just remember the last one after the loop)
}
```

REQ-JC-COMP-01: A journal-consuming computor MUST store its token (`PossibleNodeChange`) persistently across restarts. The stored token is the computor's memory of where it left off in the journal.

REQ-JC-COMP-02: A journal-consuming computor MUST use its stored token as the `since` argument to `graph.possibleMaybeChanges`. It MUST NOT construct a token value directly.

### Choosing the NodeFilter

The `NodeFilter` describes the set of node keys the computor depends on. Common patterns:

**Depend on all nodes of a specific family (head):**
```js
const myFilter = makeGroundFilter(stringToNodeName("full_event"), [makeWildcard()]);
```

This matches all nodes with head `"full_event"` and arity 1, regardless of the binding value.

**Depend on a specific concrete node:**
```js
const myFilter = makeGroundFilter(
    stringToNodeName("all_events"),
    []  // arity 0
);
```

**Depend on multiple families:**
```js
const myFilter = makeUnionFilter(
    makeGroundFilter(stringToNodeName("full_event"), [makeWildcard()]),
    makeGroundFilter(stringToNodeName("all_events"), [])
);
```

REQ-JC-COMP-03: A computor MUST use a `NodeFilter` that is broad enough to cover all node keys whose changes could affect the computor's derived state. It MAY use a filter that is broader than strictly necessary (this is conservative and safe).

---

## Handling conservative results

The journal API is conservative: `graph.possibleMaybeChanges` may return `PossibleNodeChange` values that do not correspond to a material change in the consumer's view.

REQ-JC-COMP-04: A journal-consuming computor MUST be robust to conservative results. It SHOULD:

- Re-check the current value of each affected node rather than assuming the journal action (`add`, `edit`, `delete`) precisely describes the effect on derived state.
- Use idempotent update logic that produces the same derived state whether a change is processed once or multiple times.
- Avoid performing non-idempotent event arithmetic (e.g., incrementing counters) based solely on journal observations.

**Example of robust handling:**

```js
for await (const change of graph.possibleMaybeChanges({ since, to: myFilter })) {
    // Recompute the affected portion of derived state from
    // the current graph values, not from the change metadata alone.
    const currentValue = await graph.getValue(change.nodeName, change.bindings);
    await recomputeAffectedDerivedState(change.nodeName, change.bindings, currentValue);
}
```

**Example of risky handling (avoid):**

```js
// RISKY: non-idempotent counting based on journal actions
let count = await loadCount();
for await (const change of graph.possibleMaybeChanges({ since, to: myFilter })) {
    if (change.action === 'add') count++;
    if (change.action === 'delete') count--;
}
await storeCount(count);
// Problem: if a change is reported twice, count is incorrect.
```

REQ-JC-COMP-05: If a computor must maintain an aggregate that is sensitive to exact event counts, it MUST recompute the aggregate from current graph values on each run rather than incrementally updating from journal entries.

---

## Open-ended dependencies

The journal is most valuable when a computor cannot statically enumerate all its input nodes. For example:

- A computor that summarizes all events of a certain type: it depends on every `full_event(e)` node where `e` matches a criterion. Without a journal, it would need to pull every possible binding, which is unbounded.
- A computor that sorts all nodes by some criterion: the set of nodes changes as nodes are added or removed.

In these cases, the computor:

1. Uses a `NodeFilter` that covers the family (e.g., `makeGroundFilter(head, [makeWildcard()])`).
2. On initialization, processes all matching nodes (via the journal-backed initialization pattern above, or by pulling current graph state if the journal may have gaps that matter for correctness).

---

## Stored state conventions

REQ-JC-COMP-06: A journal-using computor's stored state — the data it persists alongside the `PossibleNodeChange` token — MUST be consistent with the token's position. The token represents "derived state is up to date with respect to the journal through this position."

REQ-JC-COMP-07: If a computor fails or is interrupted during an incremental update (e.g., process crash), it MUST treat the stored token as still valid. On restart, it re-queries `graph.possibleMaybeChanges` from the stored token and re-processes any changes after it. Because update logic is idempotent (REQ-JC-COMP-04), re-processing is safe.

---

## Token portability across hosts

A computor's stored state — including its `PossibleNodeChange` token — may be synchronized across hosts as part of the graph's value storage. When a token created on host A is loaded on host B after synchronization, its behavior must be well-defined.

REQ-JC-COMP-08: A `PossibleNodeChange` token is valid across synchronized hosts. The physical journal convergence guarantee (see `incremental-graph-journal-sync.md` REQ-JS-15) ensures that for any `JournalIndex` `i`, all synchronized hosts agree that `rendered/r/journal/i` is either the same `JournalEntry` or absent.

REQ-JC-COMP-09: Public journal consumers MUST NOT need to understand host identity or raw journal indices to use a token on any host. The `PossibleNodeChange` type intentionally excludes `Hostname` and `JournalIndex` from its public fields. Token portability is achieved through the physical journal convergence guarantee, not through consumer-level host-awareness.

### When a token's underlying entry is absent

A `PossibleNodeChange` token's underlying journal entry may be absent on the receiving host. The correct behavior depends on the reason for absence.

**Absent because compacted or deleted under the journal rules:**

REQ-JC-COMP-10: If the entry is absent because it was compacted or deleted according to the rules of this specification (see `incremental-graph-journal-compaction.md` and `incremental-graph-journal-sync.md`), the absence is safe. `graph.possibleMaybeChanges` skips the absent index and resumes from the next surviving entry. The safety of this skip is guaranteed by the compaction rules (REQ-JC-13), which ensure that no stored token references an entry that has been compacted away unless the absence is harmless for the consumer.

**Absent because the host is not synchronized:**

REQ-JC-COMP-11: A `PossibleNodeChange` token is only correctness-preserving across synchronized hosts. If the receiving host has not been synchronized up to the token's journal index, the token cannot be fully interpreted on that host. The host lacks the journal state needed to determine which changes the token's original host has already accounted for.

In this state, there are two acceptable behaviors:

1. **Defer**: Do not use the token for incremental maintenance until synchronization reaches or passes the token's index.
2. **Fall back**: Treat the token as uninterpretable and perform a full recomputation using `baselinePossibleNodeChange()`.

"Skipping the missing index and continuing" MUST NOT be presented as a generally safe incremental interpretation for unsynchronized hosts.

REQ-JC-COMP-12: A journal-consuming computor whose derived value may be synchronized across hosts MUST NOT assume an unsynchronized token supports a correctness-preserving incremental update. The computor SHOULD either defer incremental maintenance or fall back to a full recomputation.

---

## Non-journal computors

Not all computors benefit from the journal. Computors with static, closed sets of inputs do not need it:

```js
// This computor depends on exactly two named input nodes.
// It does not need the journal — it simply pulls its inputs.
{
    output: "enhanced_event(e)",
    inputs: ["full_event(e)", "basic_context(e)"],
    computor: async ([event, context], old, bindings) => {
        return { ...event, ...context };
    }
}
```

The journal is intended for computors that maintain derived indexes, summaries, sorted lists, and other aggregations where the set of contributing nodes is open-ended.

---

## Testing guidelines (non-normative)

Tests for journal-using computors should verify:

1. That a journal-backed initialization (using `baselinePossibleNodeChange`) correctly initializes derived state from surviving journal entries.
2. That an incremental update (using a stored token) detects/reprocesses all relevant possible changes since the last run, while tolerating conservative or duplicate results.
3. That redundant/conservative journal results do not corrupt derived state (test by simulating duplicate entries).
4. That stored tokens survive process restart (test by persisting a token, restarting, and re-querying).
5. That the computor correctly handles `delete` entries for nodes that disappear due to sync resolution.
