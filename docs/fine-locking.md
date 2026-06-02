# Fine-Grained Locking: Implementation Guide

## Overview

Replace the current per-input-node lock model with target-only locking.
Reverse-dependency (revdeps) writes are deferred to commit time, where the
commit mutex alone provides sufficient serialization — no per-input lock
is needed.

This eliminates all input locks from the computation phase, removes the
lock-tracking fields from the Transaction object, and uses the existing
`acquireConcreteNodeLock` primitive from `lock.js` for the (sole) target
lock.

---

## 1. Correctness Verification

### 1.1 Proposed revdeps procedure

```
Under commit mutex: for each input I with a diff:
    No per-input lock needed (commit mutex is sufficient)
    Read revdeps[I] from the database (committed state, NOT batch overlay)
    Apply diff (add or remove target T)
    Write final revdeps[I] to the batch
Flush batch
```

This procedure is **correct**. Proof:

- All revdeps writes across all transactions happen exclusively inside the
  commit phase (under `withCommitMutex`). No code path writes revdeps during
  the computation phase.
- `withCommitMutex` serializes all commit phases — only one transaction at
  a time is in the commit phase.
- During a transaction's commit phase, no concurrent transaction is writing
  revdeps. Other transactions are either computing (which does not write
  revdeps) or waiting for the commit mutex.
- Therefore reading revdeps[I] from the database at commit time returns the
  latest fully committed value, which reflects all prior committed
  transactions.
- The diff (add/remove T) is applied to this latest value and written to
  the batch, which is then flushed atomically.
- No per-input lock is required because there is no concurrent writer to
  revdeps[I] during the commit phase.

### 1.2 Why no input lock is needed

Input locks previously served a single purpose: serializing concurrent
revdeps writes to the same input node. In the old design, `reconcileReverseDeps`
called `ensureReverseDepsIndexed` (which writes revdeps) during the
computation phase — outside the commit mutex. Multiple concurrent
transactions could therefore race to write the same revdeps[I] record.

In the new design, all revdeps writes are moved to the commit phase, which
is serialized by `withCommitMutex`. The race condition disappears. Input
locks become unnecessary.

### 1.3 Concurrent two-target scenario

Two transactions T1 and T2 both compute concurrently and both have a diff
for the same input I:

1. T1 enters commit phase first (acquires commit mutex).
2. T1 reads revdeps[I] = `[A, B]` (committed), appends T1 → `[A, B, T1]`,
   writes to batch, flushes batch. Releases commit mutex.
3. T2 enters commit phase (acquires commit mutex).
4. T2 reads revdeps[I] = `[A, B, T1]` (now committed), appends T2 →
   `[A, B, T1, T2]`, writes to batch, flushes batch.

Correct: both entries survive. No input lock needed.

### 1.4 Concurrent add and remove

T1's diff removes T1 from revdeps[I] (old-input cleanup). T2's diff adds
T2 to revdeps[I] (new input). T1 commits first, T2 commits second:

1. T1: reads revdeps[I] = `[T1, X]`, removes T1 → `[X]`, writes batch,
   flushes.
2. T2: reads revdeps[I] = `[X]`, appends T2 → `[X, T2]`, writes batch,
   flushes.

Correct. No input lock needed.

### 1.5 Reading committed state at commit time

At commit time, `batch.revdeps.get(I)` reads from the batch overlay. In
the new design, no code writes to `batch.revdeps` during the computation
phase — revdeps writes happen only during the commit phase itself.
Therefore the batch overlay for revdeps is empty, and `batch.revdeps.get(I)`
falls through to the database, returning the latest committed value.

---

## 2. Simplifications

### 2.1 Transaction type

**Before:**
```javascript
@typedef {object} Transaction
@property {BatchBuilder} batch
@property {TransactionIdentifierLookup} identifierLookup
@property {Set<string>} reservedIdentifiers
@property {Set<string>} heldNodeLocks           // REMOVE
@property {Map<string, () => void>} nodeLockReleases  // REMOVE
@property {Map<NodeKeyString, Promise<RecomputeResult>>} inFlight
```

**After:**
```javascript
@typedef {object} Transaction
@property {BatchBuilder} batch
@property {TransactionIdentifierLookup} identifierLookup
@property {Set<string>} reservedIdentifiers
@property {Array<RevdepDiff>} revdepDiffs        // ADD
@property {Map<NodeKeyString, Promise<RecomputeResult>>} inFlight
```

Where `RevdepDiff` is:
```javascript
@typedef {object} RevdepDiff
@property {NodeIdentifier} input    // The input node whose revdeps changes
@property {NodeIdentifier} target   // The target node being added/removed
@property {"add" | "remove"} type   // Whether to add or remove the target
```

### 2.2 Lock.js exports

**Remove** these exports (no longer used anywhere):
- `acquireTransactionNodeLock`
- `releaseConcreteNodeLocks`
- `transactionHoldsNodeLock`

**Keep** these exports for target-node locking:
- `acquireConcreteNodeLock` (the raw lock primitive)
- All existing graph-activity-lock functions (`withPullMode`, `withObserveMode`,
  `withExclusiveMode`, `withCommitMutex`, `withComputedStateMutex`, `withMutex`)

The `releaseConcreteNodeLocks` and `transactionHoldsNodeLock` functions can
be removed entirely from `lock.js` since they only operate on the
transaction's lock-tracking fields, which no longer exist.

`acquireTransactionNodeLock` can be removed since callers use
`acquireConcreteNodeLock` directly.

### 2.3 Graph_state.js changes

- Remove imports of `releaseConcreteNodeLocks`, `transactionHoldsNodeLock`
- Remove `releaseConcreteNodeLocks(tx)` call from the `finally` block in
  `withTransaction`
- Remove the lock-check in `getOrAllocateNodeIdentifier` (or remove the
  function entirely; see §3.3)
- Remove `heldNodeLocks` and `nodeLockReleases` from Transaction creation
- Before flushing the batch in the commit phase, iterate `tx.revdepDiffs`
  and apply each diff:
  ```
  for each diff in tx.revdepDiffs:
      committed = await batch.revdeps.get(diff.input)
      if diff.type == "add":
          committed = addTarget(committed, diff.target)
      else:
          committed = removeTarget(committed, diff.target)
      batch.revdeps.put(diff.input, committed)
  ```
  Because we are under the commit mutex and no revdeps writes happen
  outside the commit phase, this read-modify-write is safe without a
  per-input lock. The batch overlay for revdeps is empty (no writes to
  revdeps during computation), so `batch.revdeps.get()` returns the
  latest committed database value.

### 2.4 Class.js (resolveConcreteNode) changes

- Replace the two `acquireTransactionNodeLock` calls with a single
  `acquireConcreteNodeLock` call for the **target only**
- Remove the loop that acquires locks for each input
- Remove the pre-allocation of identifiers for input keys (lines with
  `getOrAllocateNodeIdentifier(tx, this.rootDatabase, inputKey)`)
- Allocate only the target's identifier using `txAllocateNodeIdentifier`
  directly (bypassing the lock check that `getOrAllocateNodeIdentifier`
  performs)
- Return a release callback for the target lock (or release it in the
  caller)
- Return value no longer includes `inputIdentifiers` — input identifiers
  are resolved in `maybeRecalculate` after each pull

### 2.5 Recompute.js (maybeRecalculate) changes

- **Remove** the two calls to `incrementalGraph.storage.reconcileReverseDeps`
  (lines 160 and 217 of the current file)
- **Remove** the call to `incrementalGraph.storage.ensureReverseDepsIndexed`
  (called indirectly through `reconcileReverseDeps`)
- After each input is pulled via `_pullDuringPull`, resolve its identifier
  from the transaction lookup using `lookupNodeIdentifier(tx, inputKey)`
  instead of relying on pre-allocated `nodeDefinition.inputIdentifiers`
- After the computor runs and the full dependency set is known, compute
  the revdeps diff by comparing old inputs (read from the batch inputs
  record BEFORE `ensureMaterialized` overwrites it) with new inputs
- Append each diff to `tx.revdepDiffs`:
  - For each input in old-but-not-new: `{ input, target, type: "remove" }`
  - For each input in new-but-not-old: `{ input, target, type: "add" }`
- The "cached" early-return case (when `materializedInputsMatch` is true)
  produces an empty diff set and can skip the `reconcileReverseDeps` and
  `ensureMaterialized` calls entirely

### 2.6 Invalidate.js changes

- **Remove** the call to `incrementalGraph.storage.reconcileReverseDeps`
  (line 127 of the current file)
- Compute the diff between old inputs (from `batch.inputs.get`) and the
  static input set (from `nodeDefinition.inputIdentifiers`)
- Append each diff to `tx.revdepDiffs`
- Also remove input-resolution from `resolveConcreteNode` call (input
  identifiers are not pre-allocated; use static identifiers from the
  compiled node definition)

Note: Invalidation in the current code resolves the concrete node and
uses `nodeDefinition.inputIdentifiers` (the static dependency set). In the
new design, the static dependency set is still available from the compiled
node definition and does not need dynamic resolution. The invalidation diff
is: old-inputs → static-inputs.

### 2.7 Other callers of `reconcileReverseDeps` / `ensureReverseDepsIndexed`

These functions are only called from `recompute.js` and `invalidate.js`.
They are **not** called from the database sync layer (which has its own
`unifyRevdeps` in `sync_merge_revdeps.js` — that path is a replica
unification concern and is unchanged by this design). They are also not
called from inspection, getValue, listMaterializedNodes, or other read
paths. So no other callers need changes.

---

## 3. Implementation Steps

### Step 1: Add `revdepDiffs` to Transaction

In `graph_state.js`:
- Add `revdepDiffs: []` to the Transaction creation object
- Remove `heldNodeLocks` and `nodeLockReleases` from the transaction
- Add the diff-application loop inside the commit-mutex block, before the
  batch flush

### Step 2: Remove lock-tracking from lock.js

In `lock.js`:
- Remove `acquireTransactionNodeLock`, `releaseConcreteNodeLocks`,
  `transactionHoldsNodeLock` functions
- Remove them from `module.exports`

### Step 3: Simplify graph_state.js imports and finally block

In `graph_state.js`:
- Remove the import of `releaseConcreteNodeLocks`, `transactionHoldsNodeLock`
- In the `finally` block of `withTransaction`, remove the
  `releaseConcreteNodeLocks(tx)` call

### Step 4: Change resolveConcreteNode to target-only

In `class.js`:
- Import `acquireConcreteNodeLock` from `./lock` instead of
  `acquireTransactionNodeLock`
- Keep the target lock (line 203), remove input lock loop (lines 220-222)
- Allocate target identifier via `txAllocateNodeIdentifier` (from
  `./database`) — no lock check needed
- Return `_releaseTargetLock` callback in the result
- Remove `getOrAllocateNodeIdentifier` import from `./graph_state` (no
  longer used in class.js)
- Remove `inputIdentifiers` from the returned definition

### Step 5: Change pull.js to release target lock

In `pull.js`:
- In `runWithTransaction`, after `resolveConcreteNode`, wrap the
  computation in try/finally that releases the target lock via
  `nodeDefinition._releaseTargetLock()`

### Step 6: Change maybeRecalculate to resolve identifiers post-pull

In `recompute.js`:
- Import `lookupNodeIdentifier` from `./graph_state`
- For each input, resolve the identifier via `lookupNodeIdentifier`
  after pulling, instead of using `nodeDefinition.inputIdentifiers[index]`
- Collect old inputs before `ensureMaterialized` overwrites them
- Compute diff and push to `tx.revdepDiffs`
- Remove the `reconcileReverseDeps` calls

### Step 7: Change invalidate.js similarly

In `invalidate.js`:
- Compute the diff between old inputs (from batch) and static inputs
- Push diffs to `tx.revdepDiffs`
- Remove the `reconcileReverseDeps` call

### Step 8: Clean up unused exports

- `graph_state.js`: Remove `getOrAllocateNodeIdentifier` from exports if
  no longer called externally
- `lock.js`: Remove unused function exports as described in Step 2

---

## 4. Diff-Application Helper

The diff-application loop at commit time needs a small helper:

```javascript
function applyRevdepDiff(batch, input, target, type) {
    // (called under commit mutex — no per-input lock needed)
    // batch.revdeps.get(input) reads committed state (no pending overlay writes)
    const committed = (await batch.revdeps.get(input)) ?? [];
    if (type === "add") {
        if (committed.some(id => id === target)) return; // already present
        committed.push(target);
        committed.sort(compareNodeIdentifier);
        batch.revdeps.put(input, committed);
    } else {
        const filtered = committed.filter(id => id !== target);
        if (filtered.length === 0) {
            batch.revdeps.del(input);
        } else if (filtered.length < committed.length) {
            batch.revdeps.put(input, filtered);
        }
        // else: target not found — no-op (shouldn't happen, but safe)
    }
}
```

Note: Sorting after insertion is required to maintain the sorted invariant
that `findInsertionIndex` and `ensureReverseDepsIndexed` rely on elsewhere.
Use `compareNodeIdentifier` from `database/node_identifier.js`.

---

## 5. Commit Phase Summary

The complete commit sequence in `withTransaction`:

```
1. Acquire commit mutex:
   a. Validate identifier-lookup conflicts (unchanged)
   b. For each diff in tx.revdepDiffs:
        Read revdeps[input] from database (committed state)
        Apply add/remove
        Write to batch
   c. If new allocations: append identifiers_keys_map to batch
   d. Flush batch to LevelDB
   e. If new allocations: commitTransactionLookup (update volatile)
2. Release commit mutex
3. In finally:
   a. Release reserved identifiers (unchanged)
   b. tx.revdepDiffs = [] (cleanup)
   c. Clear inFlight if not committed
```

Note: `releaseConcreteNodeLocks` is no longer needed in the finally block.
The target lock is released earlier, in the `runWithTransaction` finally
block (Step 5).

---

## 6. What Stays Unchanged

- Graph-activity mode locking (`withPullMode`, `withObserveMode`,
  `withExclusiveMode`) — no changes needed
- Commit mutex (`withCommitMutex`) — no changes needed
- Graph-level mode exclusivity (pull vs observe) — no changes needed
- Identifier allocation, lookup, and publication — no changes needed
- Read-your-writes batch overlay — no changes needed (but the diff-apply
  loop reads before any revdeps batch writes, so the overlay is empty for
  revdeps during the loop)
- The `inFlight` deduplication map on Transaction — no changes needed
- `reservedIdentifiers` cleanup — no changes needed
- Database sync/merge layer (`sync_merge_revdeps.js` et al.) — no changes
  needed
- Inspection reads, timestamp API — no changes needed

---

## 7. Edge Cases

### 7.1 Same input appears in both old and new sets

When an input is in both the old and new dependency sets, no diff is
generated. The revdeps[input] already includes the target and does not
need modification. This is the "kept input" case.

### 7.2 Multiple targets sharing the same input

Handled naturally by the commit-mutex serialization. See §1.3.

### 7.3 Input with empty revdeps after all removals

When the last dependent is removed from revdeps[input], the diff-apply
helper issues `batch.revdeps.del(input)` instead of `put(input, [])`.
This matches the current `reconcileReverseDeps` behavior.

### 7.4 Invalidation diffs vs recomputation diffs

Invalidation reconciles the node's dependency set from whatever dynamic
dependencies it accumulated back to the static input set. This may produce
both add and remove diffs, just like recomputation. Both are handled the
same way: diffs collected during the transaction callback and applied at
commit time.

### 7.5 Concurrent fresh-node allocation

When two transactions concurrently pull the same fresh node, they both
enter `resolveConcreteNode`. T1 acquires the target lock first, allocates
the identifier, computes, releases. T2 acquires the target lock, calls
`txAllocateNodeIdentifier` which finds the identifier in the committed
base (from T1's commit), skips allocation, proceeds with the existing
identifier. This is correct because the per-target lock serializes the
two transactions.

### 7.6 Null/undefined old inputs

If a node has never been materialized, `batch.inputs.get(nodeIdentifier)`
returns undefined. In this case, all new inputs generate "add" diffs.
There are no old inputs to remove.

---

## 8. Deadlock Analysis

The new design holds at most one per-node lock at any time (the current
target in the recursion stack). Per-node locks are:
1. Acquired in `resolveConcreteNode` for the target
2. Released in the `runWithTransaction` finally block after computation

Nested pulls acquire their own target lock during their own
`resolveConcreteNode` and release it before control returns to the parent.

There is no lock-ordering requirement between different nodes because no
two per-node locks are held concurrently within a single async frame.

Graph-activity mode locks (`withPullMode` / `withObserveMode`) are acquired
before any per-node lock and released after all per-node locks are released.
This forms a two-level hierarchy:
1. Graph activity mode lock (acquired first, released last)
2. Per-node target lock (acquired inside mode lock, released before mode
   lock release)

This hierarchy is acyclic and cannot deadlock.
