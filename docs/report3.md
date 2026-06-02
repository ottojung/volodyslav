# Report 3 — Locking Logic Holistic View and Simplifications

## 1. Current Architecture

### Components and their roles

| Component | Role | Why it exists |
|-----------|------|---------------|
| `lock.js` | Mode mutexes (`withPullMode`, `withObserveMode`, `withExclusiveMode`) + commit mutex (`withCommitMutex`) | Serializes concurrent top-level graph operations (pulls, observes) and the commit phase. No per-node locks remain. |
| `graph_state.js` | `Transaction` type + `GraphStorage` facade + `withTransaction()` | Groups all reads/writes for one top-level operation; provides read-your-writes batch overlays; serializes revdep writes under the commit mutex; applies identifier allocations disk-first. |
| `pull.js` | `pullNode()` + four public wrappers | The core pull logic: early freshness check, cross-transaction sharing via `nodePulls`, in-transaction dedup via `tx.inFlight`, computation delegation. |
| `recompute.js` | `internalMaybeRecalculate()` | Executes the computor, collects input identifiers/counters, builds materialized dependency records, collects revdep diffs for deferred commit-time application. |
| `invalidate.js` | `internalInvalidate()` + `internalPropagateOutdated()` | Marks nodes as "potentially-outdated" and propagates through the dependency graph; allocates identifiers as needed. |
| `class.js` | `IncrementalGraphClass` | Glue layer; wires all internal modules together; allocates identifiers via `resolveConcreteNode` using `deterministicNodeIdentifierFromNodeKey`. |

### Data flow for a top-level pull

```
graph.pull("x")
  → internalPull(graph, "x")
    → withPullMode() [mode mutex]
      → pullNode(graph, nodeKeyStr, null)
        → early freshness check (committed storage)
        → nodePulls cache check [cross-transaction sharing]
        → graph.withTransaction(txA) [creates tx with batch + id lookup overlay]
          → runDeduplicatedInTransaction(txA)
            → runWithTransaction(txA)
              → resolveConcreteNode(concreteNode, txA) [allocates identifier]
              → freshness check via txA.batch [read-your-writes]
              → maybeRecalculate(nodeDef, txA)
                → pull inputs via _pullDuringPull (nested pulls)
                → execute computor
                → collect revdep diffs
                → store value/counter in batch
              → return PullResolution {result, identifier, key, counter}
          → [after callback] withCommitMutex serializes:
              → apply revdep diffs to revdeps indices
              → flush batch to LevelDB
              → apply identifier overlay to in-memory base
          → return PullResolution (the root node's result)
```

### Cross-transaction sharing mechanism (`nodePulls` map)

`nodePulls` is a `Map<NodeKey, Promise<PullResolution>>` that enables two concurrent top-level pulls sharing a dependency to compute it only once.

**Current (buggy) approach:**

1. **Top-level pull** (`tx === null`):
   - Checks `nodePulls` for existing promise → awaits if found → returns `shared.result.value` (BUG: should be `shared.result`).
   - Creates `promise = graph.withTransaction(...)` and stores it in `nodePulls`.
   - The promise resolves after commit (because `withTransaction` commits before resolving).

2. **Nested pull** (`tx !== null`):
   - Checks `tx.inFlight` (local dedup).
   - Checks `nodePulls` (cross-transaction sharing).
   - NEW: checks `tx.pullPromise` branch.
     - Sets `nodePulls.set(nodeKeyStr, sharedPromise)` where `sharedPromise = tx.pullPromise`.
     - This **maps the nested node's key to the ROOT node's promise** — Bug: waiters get the root node's PullResolution, not this node's.
   - Falls through to `runDeduplicatedInTransaction` + `nodePulls.set(promise)`.

### `sharedPromise` branch — Why it's wrong

When a nested pull for node Z occurs inside a top-level transaction for node X:

```
tx.pullPromise = promise   // promise = graph.withTransaction(...) for X

Pull Z (nested):
  sharedPromise = tx.pullPromise  // = X's top-level promise
  nodePulls.set("z", sharedPromise)  // <-- BUG: promises X's resolution, not Z's
```

When concurrent Y's transaction awaits `nodePulls.get("z")`, it gets the resolution for X, not Z. This is fundamentally broken.

## 2. Problems to Solve

### P1. Return-shape mismatch (CRITICAL)

`pullNode` is typed as `() => Promise<RecomputeResult>`. The top-level path returns `shared.result.value` (a `ComputedValue`), not `shared.result` (the `RecomputeResult`).

**Impact:** `graph.pull("x")` returns `{ type: "x", value: 1 }` as expected by tests, but through a chain that breaks the type contract. `pullNode` called by `internalSafePullWithStatus` returns a `RecomputeResult` in the nested path but a `ComputedValue` in the top-level path. Tests expecting `{value: "data"}` from `graph.pull(...)` get `"data"`.

**Root cause:** Two places in the `tx === null` branch:
```
return shared.result.value;   // should be: return shared.result;
```

The callers `internalPull` and `internalUnsafePull` already extract `.value`:
```
const { value } = await pullNode(graph, nodeKeyStr, null);
```
So the double-extraction produces the inner raw value.

### P2. `sharedPromise` branch maps wrong keys (CRITICAL)

`nodePulls.set(nodeKeyStr, sharedPromise)` maps a nested node's key to the root transaction's promise. When a concurrent transaction awaits this entry, it gets the wrong PullResolution.

**Impact:** The "missing counter for input" error in concurrent X/Y test — transaction B awaits the shared promise for Z, gets X's PullResolution (not Z's), imports X's identifier/counter instead of Z's, then fails when trying to use it.

### P3. No commit-delay wrapping for nested node sharing

Nested pulls compute data in a transaction's batch but the data isn't committed yet. Other transactions can't safely use it until commit. Currently, nested pulls add to `nodePulls` with the raw computation promise (not commit-delayed), risk exposing uncommitted data.

### P4. Dead code and event-handler baggage from earlier lock approaches

- `.finally(() => nodePulls.delete(nodeKeyStr))` only cleans up the root node, not nested ones.
- The `sharedPromise` approach was added to attempt commit-delay but introduced P2.
- `lock.js` still has `withComputedStateMutex` and `withExclusiveMode` — not used by the pull path.
- Several files have empty `finally {}` blocks.

## 3. Simplifications to Introduce

### S1. Remove `sharedPromise` branch entirely

Delete lines 175–180 from `pull.js` (the `if (sharedPromise !== undefined)` block). It maps the wrong promise.

### S2. Replace with unified commit-delay pattern

For both top-level and nested pulls, when adding to `nodePulls`:
- **Top-level**: `nodePulls.set(key, graph.withTransaction(...))` — promise resolves after commit. Already correct.
- **Nested (inside top-level tx)**: `nodePulls.set(key, computePromise.then(r => tx.pullPromise.then(() => r)))` — waits for commit before resolving.
- **Nested (no tx.pullPromise)**: Don't add to `nodePulls` at all. This shouldn't occur in practice (every nested pull is inside a top-level transaction which sets `tx.pullPromise`).

### S3. Fix return shape in top-level path

Change both `return shared.result.value` to `return shared.result` in the `tx === null` branch. The callers already extract `.value`.

### S4. Clean up unused code

- Remove empty `finally {}` blocks.
- Keep `tx.pullPromise` but use it only as the commit barrier for nested node sharing, not as a cache entry.
- Keep `tx.inFlight` for in-transaction dedup — it's necessary and correct.

## 4. Why each piece exists

| Piece | Why |
|-------|-----|
| `nodePulls` (global map) | Two concurrent top-level pulls that share a dependency compute it only once. Without this, `zComputations` would be 2 in the X/Y test. |
| `tx.inFlight` (per-tx map) | Same-node re-entrant pulls inside a single transaction (e.g., self-pull in a computor) reuse the in-flight promise. Prevents stack overflow and duplicate work. |
| `tx.pullPromise` | Provides the after-commit barrier so that cross-transaction waiters see committed data. Without it, nested pull results published to `nodePulls` would resolve before the batch is flushed. |
| `importSharedResolution` | When a transaction reuses a result computed by another transaction, it needs to (a) import the identifier into its own overlay so `lookupNodeIdentifier` works, and (b) import the counter so `batch.counters.get` works in `maybeRecalculate`. Without this, the "missing counter for input" error occurs. |
| `PullResolution.counter` | Carried alongside the result so the waiter can seed its batch overlay with the correct counter. |
| `deterministicNodeIdentifierFromNodeKey` | Used by `resolveConcreteNode` in `class.js` to allocate identifiers deterministically per node key. Avoids collisions. |
| Early freshness check in `pullNode` | Before any transaction or cache lookup, checks the committed storage. Skips all overhead for up-to-date nodes. |
| Commit-mutex serialization of revdep writes | Removes the need for per-input node locks during computation. Revdep diffs are collected during computation, applied once under the commit mutex. |

## 5. Remaining architectural wins

- **No input-sorting needed** — the old approach sorted locks to prevent deadlock. The new approach has no per-node locks, so no sorting is required.
- **No `pendingLockReleases`** — deferred release was needed with per-node locks. Now removed.
- **Revdep diffs at commit time** — clean separation: computation collects diffs, commit phase applies them under mutex. Correct and simple.

## 6. Action items (in order)

1. Fix `pullNode` top-level return shape: `shared.result.value` → `shared.result`
2. Remove `sharedPromise` branch (lines 175–180)
3. Replace with commit-delay wrapping for nested node sharing:
   - Compute via `runDeduplicatedInTransaction`
   - If `tx.pullPromise` is set, wrap the resolution: `computePromise.then(r => tx.pullPromise.then(() => r))`
   - Store in `nodePulls`
4. Clean up empty `finally` blocks
5. Verify with `incremental_graph_volatile_consistency.test.js`
