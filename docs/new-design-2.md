# New Design: Independent Pull Transactions

## Motivation

The previous design accumulated state on the `Transaction` object across nested
pull calls: `inFlight`, `revdepDiffs`, `reservedIdentifiers`, and `pullPromise`
were all stored on the transaction and mutated by child pulls.  This made it
hard to reason about atomicity and correctness.

## Core Idea

Each `pull` call — whether top-level or nested inside a computor — is fully
self-contained.  It creates its own `Transaction` (batch + identifier lookup),
computes the node, commits everything atomically, and returns.  There is no
shared mutable state between distinct `Transaction` objects.

## Transaction Shape

```
Transaction {
  batch: BatchBuilder          // read-your-writes batch overlay
  identifierLookup: IdentifierLookup  // overlay + base lookup
}
```

No `inFlight`, `revdepDiffs`, `reservedIdentifiers`, or `pullPromise`.

Every piece of data that was previously on the `Transaction` is now:

- **Local to `pullNode`**: the function's call stack owns the commit, the
  reserved identifiers, the revdep diffs, and any dedup promises.
- **Applied immediately**: revdep diffs are written atomically with the batch
  during each pull's commit phase — they are never accumulated across scopes.

## Flow

### Top-level `graph.pull("name")`

```
internalPull(graph, name, bindings)
  └─ withPullMode (mode-mutex, shared "pull" mode)
       └─ pullNode(graph, nodeKeyStr)
            ├─ 1. committed check
            │    if node is up-to-date in storage → return { value, status: "cached" }
            ├─ 2. withTransaction(tx)
            │    tx = { batch, identifierLookup }
            │    resolveConcreteNode → outputIdentifier & reservedIdentifiers*
            │    maybeRecalculate  → computes value, pulls inputs via pullNode
            │    commit (under commit mutex):
            │      • check identifier conflicts
            │      • flush batch to disk
            │      • apply identifier lookup to in-memory state
            │    return ComputedValue
            └─ returns ComputedValue
```

### Nested pull (from inside a computor's `pullCallback`)

```
pullCallback("leaf")
  └─ _pullDuringPull(leafKey, tx)    // tx is the PARENT's transaction
       └─ pullNode(graph, leafKey)   // !!! no tx passed !!!
            same flow as top-level
              • creates its OWN Transaction
              • computes, commits, returns ComputedValue
```

The parent's `tx` is NOT passed to `pullNode`.  The nested pull creates a fresh
Transaction.  After the nested pull commits, its data is visible in committed
storage.  The parent then reads it via the normal committed-storage path.

## Revdep Diffs

Revdep diffs are no longer accumulated on `tx.revdepDiffs`.  Instead,
`maybeRecalculate` stores them in a local array.  When `pullNode`'s transaction
commits, the diffs are applied under the commit mutex — atomically with the
batch flush.

```
pullNode:
  let revdepDiffs = []

  withTransaction(tx):
    result = maybeRecalculate(..., (diff) => revdepDiffs.push(diff))
    // revdepDiffs now holds diffs from this computation
    // commit phase runs:
    //   1. apply revdep diffs (under commit mutex)
    //   2. flush batch
    //   3. update in-memory state
    return result
```

## Reserved Identifiers

`reservedIdentifiers` is managed by `resolveConcreteNode` and is returned as a
local variable from that function.  It is not stored on the Transaction.
`pullNode` owns the set and releases any reserved identifiers if the commit
fails.

```
async function pullNode(graph, nodeKeyStr):
  reserved = new Set()

  withTransaction(tx):
    nodeDef = resolveConcreteNode(tx, concreteNode, reserved)
    ...

  // on error, release identifiers in reserved
```

The `withTransaction` function no longer manages `reservedIdentifiers` at all
— the caller (`pullNode`) does.

## No Cross-Transaction Cache

The module-level `nodePulls` map is removed.  A Transaction never reads data
from another in-flight Transaction.

When a concurrent pull for the same node key happens:
1. Both create independent Transactions.
2. The first to finish commits its data to storage.
3. The second checks committed storage before computing → if the data is
   already there, it returns the cached value immediately.

This means the second pull may compute the node before the first commits,
resulting in wasted work.  This is acceptable because:

- The commit phase serializes identifier writes (conflict detection prevents
  duplicate identifier allocations).
- The computational cost of a duplicate computation is bounded.
- The design is simpler than any cross-Transaction coordination mechanism.

## In-Transaction Dedup

When a computor calls `pull("leaf")` twice concurrently (e.g.,
`Promise.all([pull("leaf"), pull("leaf")])`), each call creates its own
Transaction.  The first to commit stores the leaf's value.  The second checks
committed storage, finds the leaf, and returns the cached value.

Both may start computing before either commits, resulting in a wasted
computation.  This is a deliberate trade-off for simplicity.  The pattern of
concurrent duplicate pulls inside a single computor is rare and the wasted
work is small.

**Deterministic identifiers** ensure that duplicate commits for the same node
key produce the same identifier, so the second commit is idempotent.

## `pull` Returns `ComputedValue`

`graph.pull("name")` returns `ComputedValue` directly — the `{ value, status }`
object from `RecomputeResult`.

The status field (`"cached"`, `"computed"`, `"unchanged"`, `"changed"`) is
preserved in the return value.  Callers that need only the data can destructure:
`const { value } = await graph.pull("name")`.

## Simplifications

1. **`pullNode` no longer takes a `tx` parameter.**  Every call creates its own
   Transaction.  This eliminates the entire top-level / nested branching inside
   `pullNode`.

2. **`Transaction` has only `batch` and `identifierLookup`.**  No `inFlight`,
   `revdepDiffs`, `reservedIdentifiers`, or `pullPromise`.

3. **`importSharedResolution` is removed.**  No data is shared between
   Transactions, so there is nothing to import.

4. **`inFlight` is removed from `Transaction`.**  In-transaction dedup is
   unnecessary because each pull is its own Transaction.

5. **`nodePulls` is removed.**  No cross-Transaction cache.

6. **`computeNode` is simplified.**  It no longer needs a `tx` parameter — the
   Transaction is already active on the call stack.

7. **`_pullDuringPull` is simplified.**  It passes `nodeKeyStr` to `pullNode`
   without a `tx` parameter.

## Atomicity

Each individual pull's effects are atomic:

- The batch flush, identifier lookup commit, and revdep diff application all
  happen under the **commit mutex**.
- If the commit fails (e.g., disk error), nothing is persisted — the batch
  is discarded and reserved identifiers are released.

This means a parent pull cannot roll back a nested pull that already committed.
If the parent pull fails after a nested pull succeeded, the nested pull's data
persists.  This is a change from the previous design where all nested data was
rolled back with the parent.

## Changes to Test Expectations

The following tests verified the old rollback behavior and must be updated:

1. **"when outer computation fails, neither outer nor inner node data is
   committed"** — Now the inner node (source) IS committed because the nested
   pull completed and committed before the outer computor threw.  Expect
   `getFreshness("source")` to be `"up-to-date"` and
   `getFreshness("derived")` to be `"missing"`.

2. **"when outer pull fails, inner dependency data is also rolled back"** —
   Same as above: the inner dependency IS committed; only the outer consumer
   is missing.

3. **"Nested pull deduplication — concurrent pulls of the same key share one
   result"** — The leaf computor may run twice because both pulls start
   concurrently before either commits.  Expect `leafComputations` to be 1
   or 2 (non-deterministic with shared pull-mode mutex).  With a per-node
   exclusive lock this becomes deterministic again, but that adds complexity
   we are trading away.  Update the assertion to `>= 1` and document the
   behavior.

4. **"No conflicting concurrent allocations — concurrent pulls for different
   nodes sharing a new dependency allocate one identifier for it"** — The Z
   computor may run twice because both X and Y pull Z concurrently before
   either commits.  Same reasoning as #3.  Update assertion to `>= 1`.

These changes preserve the core correctness invariants (no data corruption,
no identifier conflicts, no dangling references) while accepting that
optimistic duplicate work can occur.

## Summary

| Concept | Before | After |
|---------|--------|-------|
| Transaction fields | batch, identifierLookup, inFlight, pullPromise, reservedIdentifiers, revdepDiffs | batch, identifierLookup |
| Nested pull tx parameter | parent's tx | none |
| Cross-Transaction cache | nodePulls (module-level Map) | removed |
| Revdep diff accumulation | stored on tx, applied at commit | stored locally, applied at commit |
| In-transaction dedup | tx.inFlight Map | eliminated — each pull is its own Transaction |
| Reserved identifiers | stored on tx | owned by pullNode, tracked locally |
| `pull` return type | `ComputedValue` (via destructuring) | `ComputedValue` (direct) |
| Rollback of nested data | cascading | independent (nested commits persist) |
| Duplicate computation | prevented (sharing) | possible (simplicity trade-off) |
