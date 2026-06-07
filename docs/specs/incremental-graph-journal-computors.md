# IncrementalGraph Journal Computors

## Purpose

This document specifies how computors (graph computation functions) should use the journal to maintain derived state incrementally.

The journal enables incremental maintenance for computors with open-ended dependencies — cases where a computor depends on a family of nodes (e.g., all nodes with a given head or matching a pattern) and cannot statically enumerate its inputs.

This document uses normative language for requirements on journal-using computors and provides non-normative examples for illustration.

---

## The computor journal pattern

A journal-using computor follows this lifecycle:

1. **Full computation**: On first run (or when no prior token is available), compute derived state for all relevant nodes. Store the last `PossibleNodeChange` seen during the scan.
2. **Incremental update**: On subsequent runs, call `possibleMaybeChanges` with the stored token and an appropriate `NodeFilter`. Update only the affected portion of derived state.
3. **Store token**: After processing, store the last `PossibleNodeChange` from the scan for use as the next `since` value.

---

## Pattern in detail

### Step 1: Full computation

```js
// First run or baseline recomputation
let lastChange = baselinePossibleNodeChange();
for await (const change of possibleMaybeChanges({
    since: lastChange,
    to: myFilter,
})) {
    await updateDerivedState(change);
    lastChange = change;
}
await storeToken("my-computor-state", lastChange);
```

The `baselinePossibleNodeChange()` call provides a sentinel that causes `possibleMaybeChanges` to return all available matching changes. The computor processes each change and remembers the last one.

### Step 2: Incremental update

```js
// Subsequent run
const since = await loadToken("my-computor-state");
for await (const change of possibleMaybeChanges({
    since,
    to: myFilter,
})) {
    await updateDerivedState(change);
    // Optionally update the token progressively
    // (or just remember the last one after the loop)
}
```

REQ-JC-COMP-01: A journal-consuming computor MUST store its token (`PossibleNodeChange`) persistently across restarts. The stored token is the computor's memory of where it left off in the journal.

REQ-JC-COMP-02: A journal-consuming computor MUST use its stored token as the `since` argument to `possibleMaybeChanges`. It MUST NOT construct a token value directly.

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

The journal API is conservative: `possibleMaybeChanges` may return `PossibleNodeChange` values that do not correspond to a material change in the consumer's view.

REQ-JC-COMP-04: A journal-consuming computor MUST be robust to conservative results. It SHOULD:

- Re-check the current value of each affected node rather than assuming the journal action (`add`, `edit`, `delete`) precisely describes the effect on derived state.
- Use idempotent update logic that produces the same derived state whether a change is processed once or multiple times.
- Avoid performing non-idempotent event arithmetic (e.g., incrementing counters) based solely on journal observations.

**Example of robust handling:**

```js
for await (const change of possibleMaybeChanges({ since, to: myFilter })) {
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
for await (const change of possibleMaybeChanges({ since, to: myFilter })) {
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
2. On first run, processes all matching nodes (via `baselinePossibleNodeChange` or by pulling the current state).
3. On subsequent runs, uses `possibleMaybeChanges` to discover only the nodes that may have changed.

---

## Stored state conventions

REQ-JC-COMP-06: A journal-using computor's stored state — the data it persists alongside the `PossibleNodeChange` token — MUST be consistent with the token's position. The token represents "derived state is up to date with respect to the journal through this position."

REQ-JC-COMP-07: If a computor fails or is interrupted during an incremental update (e.g., process crash), it MUST treat the stored token as still valid. On restart, it re-queries `possibleMaybeChanges` from the stored token and re-processes any changes after it. Because update logic is idempotent (REQ-JC-COMP-04), re-processing is safe.

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

1. That a full computation (using `baselinePossibleNodeChange`) correctly initializes derived state.
2. That an incremental update (using a stored token) correctly detects only changes since the last run.
3. That redundant/conservative journal results do not corrupt derived state (test by simulating duplicate entries).
4. That stored tokens survive process restart (test by persisting a token, restarting, and re-querying).
5. That the computor correctly handles `delete` entries for nodes that disappear due to sync resolution.
