# Fine-Grained Locking: Target-Only Compute with Deferred Diff Application

## Summary

This document evaluates whether we can eliminate input-node locks during the
computation (pull / invalidate) phase by deferring shared-dependency writes
to a short-lived **diff-application phase**.

The proposal is:

1. **Phase 1 (target only)**: Acquire only the target node lock. Resolve the
   target's concrete node (look up / tentatively allocate identifiers for
   inputs). Run the computor and any nested pulls. Collect "diffs" — pending
   mutations to other nodes' records — but do not apply them yet.

2. **Phase 2 (sorted inputs, narrow locks)**: For each unique input node that
   needs a reverse-dependency update, acquire that input's lock, apply the
   diff (read-modify-write), release.  All diffs go into the same transaction
   batch so the commit remains atomic.

3. **Phase 3 (commit)**: Flush the batch disk-first; update volatile state.

---

## What a Pull Currently Mutates

A top-level pull for node **T** (the target) with direct inputs `{I1, I2}`:

| Write | Owner | Current lock |
|-------|-------|------|
| `values[T]` ← new computed value | **T** | T |
| `freshness[T]` ← `"up-to-date"` | **T** | T |
| `counters[T]` ← counter + 1 | **T** | T |
| `timestamps[T]` ← now | **T** | T |
| `inputs[T]` ← current input identifiers + counters | **T** | T |
| `revdeps[I1]` ← append T | **I1** | I1 |
| `revdeps[I2]` ← append T | **I2** | I2 |
| *If old inputs exist:* remove T from their `revdeps` | **old I** | old I |

Only the **reverse-dependency writes** are owned by other nodes. Everything
else is owned by the target itself and is already protected by the target lock.

The input locks exist today to protect `revdeps[I]` writes and concurrent
identifier allocation for input keys.

---

## 1.  Deadlock Freedom Analysis

### 1.1  **Skipped**

### 1.2  Formal argument

**Lock hierarchy (new design):**

1. Graph activity mode lock (`GRAPH_ACTIVITY_KEY` — `"pull"` or `"observe"`).
2. Per-node locks, acquired in a **total order** defined by the string-encoding
   of the `NodeKeyString`.
3. Within one transaction, no lock is acquired while holding a lock on a
   **later** node in the total order.

**Proof sketch:**

- Phase 1 only acquires the current target's lock.  Recursive nested pulls
  acquire their target locks in dependency order, which is a strict DAG.
  Since the dependency relation is acyclic, the lock-acquisition chain
  respects the global total order (every edge goes from a node to one of its
  dependencies, and dependencies are ≤ the node's other direct inputs in the
  sort order).  No cycle possible.

- Phase 2 acquires input locks in the same total order (sorted by key).
  No other locks are held during Phase 2.  Two callers contending on the
  same set of input keys will request them in the same order → no cycle.

**Conclusion:** The proposed design is deadlock-free under standard
two-phase-locking assumptions with a fixed lock order.

---

## 2.  Input Lock Requirements: What is Actually Needed

### 2.1  Reverse-dependency updates (must be deferred)

`reconcileReverseDeps()` and `ensureReverseDepsIndexed()` write to an input
node's `revdeps` record.  These are **input-owned** records, not target-owned.

Without locking the input during the write, two concurrent transactions that
both list the same input as a dependency would race:

1. T1 reads `revdeps[I]` = `[]`
2. T2 reads `revdeps[I]` = `[]`
3. T1 writes `revdeps[I]` = `[T1]`
4. T2 writes `revdeps[I]` = `[T2]` (overwrites T1)

Result: T1 is permanently missing from `I`'s dependents → T1 will not be
invalidated when `I` changes.

**Under the deferral strategy:** Phase 2 holds `I`'s lock, reads the current
`revdeps[I]`, adds/removes the target, and writes back.  Two concurrent
Phase‑2 calls on `I` are serialized by the lock, so neither update is lost.

### 2.2  Stale-edge removal (also deferred)

When a target switches from input `I_old` to `I_new`, `reconcileReverseDeps`
removes the target from `I_old`'s revdeps and adds it to `I_new`'s revdeps.
Both writes are input-owned and must be deferred for the same reason as §2.1.

Under Phase 2 this is handled naturally: the diff set records both the remove
and the add, and each is applied under the respective input's lock.

### 2.3  Identifier allocation for inputs (deserves care)

During `resolveConcreteNode()` the parent allocates identifiers for input keys
that have not yet been seen in this transaction.  This write is local to the
transaction's overlay (not yet committed).  Two transactions could allocate
*different* identifiers for the same key and only detect the conflict at
commit time.

**In the current code** this is prevented by requiring the input lock before
allocation (`getOrAllocateNodeIdentifier` throws if the lock is not held).

**In the proposed design** there are two options:

#### Option A: Optimistic allocation with commit-time conflict detection

- Allocate in the transaction overlay during Phase 1 (no input lock needed).
- At commit time, the existing conflict checks (graph_state.js:398-408)
  detect if another transaction already published a different identifier for
  the same key.
- On conflict, the second transaction **must abort and retry**.

This is incompatible with the project constraint that non-pure computations
must not be retried.

#### Option B: Defer allocation to Phase 2 (recommended)

- During Phase 1, if an input key has no identifier yet, **do not allocate**.
  Instead, record a `{ key, placeholder }` in the diff set.
- In Phase 2, under the input's lock:
  - Check the committed lookup: does this key already have an identifier?
  - If yes: use the existing one.
  - If no: allocate a fresh identifier and publish it atomically with the
    revdeps update.

But this requires that during Phase 1 no operation needs the input's
identifier.  Let's check:

- **Nested pull** (`_pullDuringPull`) uses the **semantic key**, not the
  identifier.  Fine.
- **Counter read** uses the identifier:
  ```javascript
  const inputCounter = await batch.counters.get(inputIdentifier);
  ```
  This happens *after* the nested pull.  If the input is freshly pulled,
  the nested pull already allocated an identifier for it (during the nested
  pull's own `resolveConcreteNode`).  So the parent sees the identifier
  in the transaction overlay — no need to pre-allocate in the parent.

- **Materialized dependency record** also uses the identifier:
  ```javascript
  materializedDependencies.add(dynamicIdentifier, dynamicCounter);
  ```
  This happens inside the pull callback, after the nested pull returns.
  The identifier is already in the overlay.

**Conclusion:** The parent does not need to pre-allocate identifiers for
inputs.  The nested pull's `resolveConcreteNode` will allocate if needed.
The parent can simply look up the identifier from the overlay after the
nested pull returns (or receive it in the return value).

Therefore we can drop the "lock before allocate" constraint for input nodes
and remove input locks from Phase 1 entirely.

---

## 3.  Applicability to Invalidation

An `invalidate(T)` call does:

1. Read `T`'s inputs via `getInputs(T, batch)`.
2. Mark `freshness[T]` = `"potentially-outdated"`.
3. Call `reconcileReverseDeps(T, newInputs, batch)` to update revdeps.
4. Propagate outdated status to dependents.

Steps 3 writes to input-owned `revdeps`.  Under the deferral strategy:

- Phase 1: read inputs, mark freshness, propagate (nested invalidates).
- Collect diffs: `{ add T to revdeps[I_new], remove T from revdeps[I_old] }`.
- Phase 2: apply diffs under per-input locks.

This works identically to the pull case.

---

## 4.  The `withCommitSnapshot` Inefficiency

`listMaterializedNodes()` holds the commit mutex for the duration of a full
scan (`withCommitSnapshot`).  This serializes commits during the scan.

This is a separate concern from the node-lock design.  It is mentioned here
because the diffs approach does not address it.  If needed, a future change
could snapshot the metadata or use an incrementally maintained index.

---

## 5.  Correctness Caveats

### 5.1  Stale counter read is benign

In Phase 1, after a nested pull returns, the parent reads the input's counter.
Without holding the input lock, another transaction could increment the
counter between the read and the commit.  This results in a dependency record
that says "input at counter X" when the input is actually at X+1.

This is **not a correctness bug**.  The next invalidation check will compare
the recorded counter (X) against the current counter (X+1), detect the
mismatch, and mark the target as potentially-outdated.  The stale record
merely means one extra recomputation will occur — a performance cost, not a
semantic error.

### 5.2  Concurrent identifier allocation

If two transactions both need a new identifier for the same input key and one
commits first, the second will detect the conflict at commit time (§2.3
Option B defers to Phase 2 so this does not arise).  If Option A were used
instead, the second transaction would fail and need to retry, which is
unacceptable per project constraints.

Option B avoids the problem entirely: allocation happens under the input lock
in Phase 2, where only one transaction at a time can commit for that key.

---

## 6.  What Needs to Change

### 6.1  ResolveConcreteNode (no input locks)

```diff
 async resolveConcreteNode(concreteNode, tx) {
     await acquireTransactionNodeLock(tx, concreteNode.output);
 
-    const orderedInputs = Array.from(uniqueInputs).sort(...);
-    for (const inputKey of orderedInputs) {
-        await acquireTransactionNodeLock(tx, inputKey);
-    }
     
     // Look up identifiers, but don't allocate for inputs here.
     // Allocation happens in the nested pull's own resolve.
     const inputIdentifiers = [];
     for (const inputKey of concreteNode.inputs) {
-        inputIdentifiers.push(
-            getOrAllocateNodeIdentifier(tx, this.rootDatabase, inputKey)
-        );
+        // Look up only; return undefined if not allocated yet.
+        // The nested pull will allocate on demand.
+        inputIdentifiers.push(
+            txNodeKeyToId(tx.identifierLookup, inputKey)
+        );
     }
     
     return {
         outputKey: concreteNode.output,
         inputKeys: concreteNode.inputs,
         outputIdentifier: getOrAllocateNodeIdentifier(/* ... */),
         inputIdentifiers,
         computor: concreteNode.computor,
     };
 }
```

### 6.2  Recomputation (collect diffs instead of mutating input records)

In `maybeRecalculate`, replace `reconcileReverseDeps` and
`ensureReverseDepsIndexed` with diff accumulation.

```diff
- await incrementalGraph.storage.reconcileReverseDeps(
-     nodeIdentifier,
-     materializedDependencies.identifiers,
-     batch
- );
+ // Record diff: reconcile revdeps for old vs new inputs.
+ tx.revdepsDiffs.push({
+     node: nodeIdentifier,
+     oldInputs: previousInputIdentifiers,  // captured at start
+     newInputs: materializedDependencies.identifiers,
+ });
```

### 6.3  Transaction (add diff accumulator)

```diff
 const tx = {
     batch,
     identifierLookup: txLookup,
     reservedIdentifiers: new Set(),
     heldNodeLocks: new Set(),
     nodeLockReleases: new Map(),
     inFlight: new Map(),
+    revdepsDiffs: [],  // { node, oldInputs, newInputs }
 };
```

### 6.4  Commit (apply diffs before flush)

```diff
 async withTransaction(fn) {
     const value = await fn(tx);
 
+    // Phase 2: apply revdeps diffs under per-input locks.
+    await applyRevdepsDiffs(tx, rootDatabase);
+    // (acquires input locks in sorted order, reads/writes revdeps)
 
     await withCommitMutex(sleeper, rootDatabase.currentReplicaName(), async () => {
         // existing commit logic...
     });
 }
```

`applyRevdepsDiffs` iterates each unique input across all diffs in sorted
key order.  For each input:

1. Acquire the node lock (`acquireConcreteNodeLock`).
2. For each diff that affects this input (add or remove target):
   - Read current `revdeps[input]`.
   - Modify the array (add or remove).
   - Write back.
3. Release the node lock.

#### Could diffs for different transactions race on the same input?

Phase 2 acquires input locks in sorted order.  If T1 and T2 both have a diff
for input I, one will acquire I's lock first, apply its diff, release; then
the other acquires, reads the updated revdeps, applies, releases.  Both
diffs are preserved.  This is correct.

### 6.5  getOrAllocateNodeIdentifier (remove lock guard)

```diff
 function getOrAllocateNodeIdentifier(tx, rootDatabase, nodeKey) {
     const existing = lookupNodeIdentifier(tx, nodeKey);
     if (existing !== undefined) {
         return existing;
     }
-    if (!transactionHoldsNodeLock(tx, nodeKey)) {
-        throw new Error(...);
-    }
     return txAllocateNodeIdentifier(/* ... */);
 }
```

This guard becomes unnecessary because allocation is no longer deferred to
Phase 2 — it happens during the nested pull's own `resolveConcreteNode` which
holds the nested pull's **own** (target) lock, not the parent's input lock.
Since each nested pull holds only its own target lock during allocation,
there is no broader serialization requirement.

(But see §2.3 — if two non-nested top-level pulls concurrently discover the
same new dependency key, both may allocate.  The commit-time conflict check
catches the duplicate.  This is a legitimate concern; see §5.2 and the chart
below for the recommended approach.)

### 6.6  Invalidation (same pattern)

`internalInvalidate` currently calls `reconcileReverseDeps`.  Replace with
diff accumulation, identical to the pull path.

---

## 7.  Summary of Concerns

| Concern | Severity | Addressed? |
|---------|----------|-----------|
| Revdeps race without input lock | **Data loss** | Phase 2 apply under lock (§2.1) |
| Stale-edge removal race | **Data loss** | Phase 2 apply under lock (§2.2) |
| Concurrent identifier allocation | **Abort/retry** | Avoided by in-nested-pull allocation (§2.3) |
| Deadlock in Phase 1 | **Program hang** | DAG + single lock at a time → impossible (§1.2) |
| Deadlock in Phase 2 | **Program hang** | Sorted order → impossible (§1.2) |
| Stale counter in dependency record | **Extra recomputation** | Benign (§5.1) |
| Long compute holds target lock | **Unavoidable** | Accepted in requirements |
| `withCommitSnapshot` scan | **Commit serialization** | Not addressed by this design |

---

## 8.  Conclusion

The target-only-compute / deferred-diff strategy is **sound** and
**deadlock-free** under the proposed lock hierarchy.

The key insight is that every mutation to an input-owned record is a
`revdeps` update, and those updates are **commutative** when serialized by
the input lock: applying diff A then diff B gives the same result as B then A,
as long as each is a read-modify-write under the same lock.  There is no
cross-input invariant that requires holding multiple input locks
simultaneously.

The changes required are:

1. Remove input locks from `resolveConcreteNode`.
2. Collect revdeps diffs during computation instead of applying them inline.
3. Add a `diff-application` phase in `withTransaction` before the commit
   mutex, which applies diffs under per-input locks in sorted order.
4. Remove the "lock before allocate" guard in `getOrAllocateNodeIdentifier`.
5. Ensure the nested pull's resolver (which holds the nested target lock)
   handles allocation for its own inputs, so the parent never needs to
   pre-allocate identifiers for them.
