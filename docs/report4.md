# Report 4: Locking & Flow Review

## Findings

### Dead Code

#### 1. `withComputedStateMutex` — zero callers

`lock.js` defines and exports `withComputedStateMutex` (using `COMPUTED_STATE_KEY`) but
no production code or test ever calls it.  `commitTransactionLookup` is invoked
directly inside `withCommitMutex` — the computed-state mutex is never acquired.

**Impact**: Exporting unused primitives creates the false impression that
commit serialization uses a two-mutex handoff.  Only `COMMIT_KEY` matters.

**Action**: Remove `withComputedStateMutex` and `COMPUTED_STATE_KEY` from
`lock.js`.  Update the JSDoc in `root_database.js:getActiveIdentifierLookup()`
that references it.

#### 2. `reconcileReverseDeps` — zero callers (production or test)

`graph_state.js` defines `reconcileReverseDeps` and exposes it on
`GraphStorage`.  Nothing calls it.  The revdep diff application in
`withTransaction` (lines 383-413) is the only active reverse-dep reconciliation
path.

**Action**: Remove `reconcileReverseDeps` from `graph_state.js`.  Keep
`ensureReverseDepsIndexed` — it is used by tests.

#### 3. `inFlightIdentifiers` set grows without bound

After a successful commit, allocated identifiers are **never removed** from
`_computed.inFlightIdentifiers`.  The set lives until a replica switch or
clear.  With the deterministic-identifier path (`pullNode` passes
`new Set()`), the in-flight check in `txAllocateNodeIdentifier` is a no-op.
Only `getOrAllocateNodeIdentifier` (called from `invalidate.js`) still passes
the live global set for its random-allocation path.

**Impact**: Slow unbounded memory growth in long-running processes that never
switch replicas.

**Action**: See "Larger Simplifications" below.

---

### Inconsistencies & Doc Drift

#### 4. `lock.js` comment on `withMutex` vs actual use

The JSDoc says "only one exclusive operation runs at a time", but `withMutex`
is a generic helper keyed on `MUTEX_KEY`.  `withExclusiveMode` is the one
that truly excludes all graph activity by layering `MUTEX_KEY` + mode mutex.
The comment on `withMutex` over-promises.

#### 5. `root_database.js` JSDoc references dead mutex

`getActiveIdentifierLookup()` JSDoc says it should only be called inside
`withComputedStateMutex` — but that mutex is never acquired anywhere.

#### 6. `lock.js` `withComputedStateMutex` JSDoc warns about deadlocks

The "non-reentrant" warning is accurate for a per-replica mutex, but since
the function is dead, the warning is misleading.

#### 7. `IncrementalGraphPullAccess.withTransaction` type — legacy from previous design

Line 35 of `pull.js` was updated during the new-design implementation but
the surrounding typedef carries no comment explaining why `procedure` returns
`{value, revdepDiffs}` rather than a bare value.

---

### Code Duplication

#### 8. `internalPull` and `internalSafePullWithStatus` share identical setup

Both call `withPullMode` + `serializeNodeKey`.  `internalPull` could delegate:

```js
async function internalPull(graph, nodeName, bindings = []) {
    const { value } = await internalSafePullWithStatus(graph, nodeName, bindings);
    return value;
}
```

#### 9. `internalPullByNodeKeyDuringPull` and `internalUnsafePull` differ only in key serialization

`internalUnsafePull` serializes then calls `pullNode`.  `internalPullByNodeKeyDuringPull`
calls `pullNode` directly with an already-serialized key.  They cannot share
a single helper without an extra branch, but the similarity is worth noting.

#### 10. `serializeNodeKey` called in four places

`internalPull`, `internalSafePullWithStatus`, `internalUnsafePull`,
`internalInvalidate` — each serializes the same `{head, args}` shape.  A small
`serializeHeadKey(head, bindings)` helper would DRY this up.

---

### Race Windows (All Benign, But Worth Listing)

#### 11. `pullNode` early committed check — TOCTOU

Lines 62-71 read committed storage before creating a Transaction.  Between the
read and the transaction, a concurrent invalidation or pull can change the
node's freshness/value.  The in-transaction re-check (lines 87-97) catches
this correctly — at worst it creates an unnecessary Transaction and returns
cached data.  Correct but subtle.

---

### Larger Simplifications

#### 12. Make `getOrAllocateNodeIdentifier` use deterministic identifiers

Currently `getOrAllocateNodeIdentifier` (called from `invalidate.js`) uses
`rootDatabase.generateNodeIdentifier()` — a random generator — and passes
the live `inFlightIdentifiers` set for collision avoidance.  If it used
`deterministicNodeIdentifierFromNodeKey` (like `resolveConcreteNode` does),
the entire in-flight tracking system becomes unnecessary:

- No cross-transaction identifier conflict is possible (same key → same id).
- `inFlightIdentifiers` Set (unbounded growth) can be removed.
- `releaseInFlightIdentifier()` can be removed.
- The `reserved` Set (failure cleanup) becomes unnecessary.
- The `try/catch` releasing reserved identifiers in `pullNode` and
  `invalidate.js` can be removed.
- The commit-phase conflict checks in `withTransaction` (lines 423-439) can
  be removed — they would never fire.
- The `inFlightIdentifiers` and `reserved` parameters to `txAllocateNodeIdentifier`
  can be removed.
- `resolveConcreteNode` no longer needs the `inFlightIdentifiers` parameter.

This would eliminate roughly 40 lines of code across 5 files, remove a
memory leak (`inFlightIdentifiers`), and simplify the failure semantics.

**Trade-off**: Identifiers for non-deterministic paths would change from
random to SHA-256-based.  Since identifiers are opaque strings, this is
not externally visible.

---

### Lock Hierarchy (Summary)

```
  withExclusiveMode
    ├─ MUTEX_KEY (serialize exclusive callers)
    └─ GRAPH_ACTIVITY_KEY "exclusive" (block all activity)

  withPullMode          GRAPH_ACTIVITY_KEY "pull"     (concurrent)
  withObserveMode       GRAPH_ACTIVITY_KEY "observe"  (concurrent)
  withPullMode + withObserveMode  — run concurrently (different modes)

  withCommitMutex       COMMIT_KEY per-replica        (serialize flushes)
```

The hierarchy is acyclic and deadlock-free.  Pull and observe use only the
mode mutex.  Commit uses only `COMMIT_KEY`.  Exclusive mode nests
`MUTEX_KEY` before `GRAPH_ACTIVITY_KEY`.

**No lock is ever acquired inside a commit mutex** — the mode mutex is
acquired by the caller before the Transaction is created, and `COMMIT_KEY`
is only acquired during the commit phase of `withTransaction`.

---

### Flow Diagram Recap

```
pull(name, bindings)
  withPullMode
    pullNode(key)
      [committed check — fast path]
      withTransaction(tx)
        resolveConcreteNode  → deterministic id
        maybeRecalculate     → pulls deps, computes
           _pullDuringPull(key)
             pullNode(key)   → own Transaction, commits independently
        commit (commit mutex):
          apply revdep diffs
          flush batch
          apply id lookup
        return RecomputeResult
      return value

invalidate(name, bindings)
  withObserveMode
    internalUnsafeInvalidate
      withTransaction(tx)
        resolveConcreteNode
        mark outdated
        allocate/resolve inputs  → may use random ids
        collect revdep diff
        propagateOutdated (recursive)
        commit (commit mutex)
```
