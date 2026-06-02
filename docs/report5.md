# Locking Flow Analysis Report

## 1. Locking Primitives Overview

The implementation defines three key families in `backend/src/generators/incremental_graph/lock.js`:

| Primitive | Key | Mechanism | Purpose |
|---|---|---|---|
| `withMutex(MUTEX_KEY)` | singleton `"incremental-graph-operations"` | exclusive mutex | Serialize exclusive graph ops (db opens, migrations) |
| `withObserveMode(GRAPH_ACTIVITY_KEY, "observe")` | singleton `"incremental-graph-activity"` | mode-mutex (shared same-mode) | invalidate + inspection reads |
| `withPullMode(GRAPH_ACTIVITY_KEY, "pull")` | singleton `"incremental-graph-activity"` | mode-mutex (shared same-mode) | all pull activity |
| `withCommitMutex(COMMIT_KEY, replicaName)` | per-replica `"incremental-graph-commit(<replica>)"` | exclusive mutex | serialize commit phases |
| `withExclusiveMode` | `MUTEX_KEY` → `GRAPH_ACTIVITY_KEY("exclusive")` | nested exclusive + mode-mutex | full graph exclusion |

The mode-mutex (`sleeper.withModeMutex`) allows concurrent callers with the same mode. Different modes are mutually exclusive. Mode-groups are dequeued in FIFO order.

## 2. Operation Lock Graphs

### `pull(nodeName, bindings)` — `pull.js`

```
withPullMode(sleeper)          // GRAPH_ACTIVITY_KEY("pull")  — shared, many pulls overlap
  └─ pullNode(graph, nodeKeyStr)
       └─ graph.withTransaction(fn)
            ├─ fn(tx)          // computation — NO lock held
            └─ withCommitMutex  // COMMIT_KEY(replica) — exclusive per-replica
                 ├─ apply revdep diffs to batch
                 ├─ flush batch to LevelDB
                 └─ commitTransactionLookup
```

**No per-node pull mutex exists.** Two pulls on the same node both acquire `"pull"` mode (compatible) and run their computation concurrently. Only the commit phase is serialized.

### `invalidate(nodeName, bindings)` — `invalidate.js`

```
withObserveMode(sleeper)       // GRAPH_ACTIVITY_KEY("observe") — shared, many invalidates overlap
  └─ internalUnsafeInvalidate
       └─ graph.withTransaction(fn)
            ├─ fn(tx)
            └─ withCommitMutex  // COMMIT_KEY(replica)
                 ├─ apply revdep diffs
                 ├─ flush batch
                 └─ commitTransactionLookup
```

Excluded from pulls (mode conflict: `"observe"` vs `"pull"`), but compatible with other observes and inspection reads.

### `getValue` / `getFreshness` / `getCreationTime` / `getModificationTime` — `inspection.js`

```
withObserveMode(sleeper)       // GRAPH_ACTIVITY_KEY("observe")
  └─ read from storage (LevelDB direct reads, no transaction)
```

No per-node lock, no commit mutex. Compatible with invalidates, excluded from pulls.

### `listMaterializedNodes()` — `inspection.js`

```
withObserveMode(sleeper)       // GRAPH_ACTIVITY_KEY("observe")
  └─ withCommitSnapshot        // COMMIT_KEY(replica) — pause concurrent commits
       └─ iterate storage for keys
```

Acquires commit mutex while holding observe mode. This pauses all concurrent commits for a consistent enumeration.

### `withExclusiveMode(sleeper)` — `lock.js`

```
withMutex(MUTEX_KEY)           // serialize concurrent exclusive callers
  └─ withModeMutex(GRAPH_ACTIVITY_KEY, "exclusive")
       └─ procedure            // no pull/observe can overlap
```

Used during `synchronizeDatabase()` to ensure no graph activity runs during checkout/migration/merge.

## 3. Lock Hierarchy

```
  MUTEX_KEY                              (exclusive, top level)
      │
      v
  GRAPH_ACTIVITY_KEY                    (mode-mutex, modes: observe/pull/exclusive)
      │
      v
  COMMIT_KEY(replicaName)               (exclusive, bottom level)
```

All lock acquisitions follow this strict top-down order. No code path acquires a higher-level lock while holding a lower-level one.

## 4. Deadlock Analysis

**No deadlock cycles exist.** Reasons:

1. **Strict layering**: The hierarchy is a DAG (MUTEX_KEY → GRAPH_ACTIVITY_KEY → COMMIT_KEY). No code path reverses this order.

2. **Per-node pull mutex absent**: The design spec describes a per-node `PULL_NODE_KEY(nodeKey)` acquired inside `withPullMode`. In the current code, this lock simply does not exist. While this is a drift from spec (see §5), the absence removes the only potential deadlock vector — a cycle between node A waiting on node B's lock while B waits on A's lock. Because there is only ONE graph-activity mode lock shared by all pulls, no per-node lock cycle can form.

3. **Single mode-mutex per operation**: Each operation acquires exactly one mode-mutex (`"observe"` or `"pull"`). No operation acquires multiple mode-mutexes. There is no AB/BA pattern possible.

4. **Commit mutex is leaf-only**: `withCommitMutex` is always acquired last, inside either `withObserveMode` or `withPullMode` or `withExclusiveMode`. No code path acquires a mode-mutex while holding the commit mutex.

## 5. Drifts from Locking Design Spec

Reference: `docs/specs/incremental-graph-locking-design.md`

### 5.1 Missing Per-Node Pull Mutex (Major)

**Spec says** (§2.2 "Per-node pull key"): *"There is one exclusive key per concrete node — PULL_NODE_KEY(nodeKeyString) — acquired through withMutex. It serializes same-node pulls without blocking pulls on different nodes."*

**Implementation**: No `PULL_NODE_KEY` exists. `pullNode` acquires no per-node lock. Two pulls on the same node run concurrently through the entire computation phase.

**Consequences**:
- **Wasted computation**: Two concurrent pulls on the same unseen node both compute the same value. The work is duplicated.
- **Counter inconsistency**: Both pulls read the same counter, increment it, and write the same value. After both commits, the counter is N+1 instead of N+2. Example: counter reads 5 → both compute 6 → both write 6. Final counter is 6 rather than 7.
- **Read-your-writes gap**: Pull A of node X triggers computation that internally pulls dependency Y (via `_pullDuringPull`). Pull B of node X starts after A begins but before A commits. B reads stale values for Y (A's updated Y-value is still in A's uncommitted batch). B computes based on pre-A data, writes result, commits. Then A commits its (potentially different) result over B's. Final state matches A's computation, which used the correct Y-value. This is correct, but B's work is wasted and the intermediate state is confusing.

**Severity**: Medium. The counter inconsistency means the counter is not a reliable "number of recomputations" metric, but no correctness invariant depends on strict counter monotonicity per pull. The commit mutex serializes writes, so last-writer-wins on the counter yields a correct (if non-intuitive) final value.

### 5.2 `listMaterializedNodes` Acquires Commit Mutex (Minor)

**Spec does not mention** `listMaterializedNodes` at all.

**Implementation** acquires `withCommitSnapshot` (→ `withCommitMutex`) inside `withObserveMode`. This pauses concurrent commits while iterating. The purpose is a consistent enumeration.

**Drift**: This lock acquisition order (observe-mode → commit-mutex) follows the established hierarchy (GRAPH_ACTIVITY_KEY → COMMIT_KEY), so it does not create deadlock risk. It is a conservative choice for snapshot consistency.

**Severity**: None. Correct and safe, though a LevelDB snapshot would be lighter.

### 5.3 `withExclusiveMode` Uses a Third Mode "exclusive" (Extension)

**Spec describes** only two modes: `"observe"` and `"pull"`.

**Implementation** adds a third mode `"exclusive"` for `withExclusiveMode`. This mode is incompatible with both `"observe"` and `"pull"`, providing full graph exclusion.

**Severity**: None. This is a natural extension of the mode-mutex pattern.

### 5.4 `graph_api.js` Holds MUTEX_KEY Across Invalidate-then-Pull Sequence

**Spec does not specify** the `graph_api.js` layer.

**Implementation** (`backend/src/generators/interface/graph_api.js`) holds `MUTEX_KEY` across a sequence of `invalidate()` then `pull()`. These inner operations briefly release-and-reacquire observe-mode/pull-mode, but `MUTEX_KEY` is held throughout. This prevents `withExclusiveMode` (which needs `MUTEX_KEY`) from interleaving.

**Severity**: Low. This is intentional — it prevents `synchronizeDatabase()` from running between invalidate and pull during an update. Not a deadlock risk since `MUTEX_KEY` is the top-level lock.

## 6. Summary Table

| Spec Requirement | Status | Note |
|---|---|---|
| Invalidates exclusive with pulls | ✅ Compliant | mode conflict observe/pull |
| Inspections concurrent with invalidates | ✅ Compliant | both use observe mode |
| Pulls exclusive with inspections | ✅ Compliant | mode conflict pull/observe |
| Pulls on same node serialize | ❌ NON-COMPLIANT | per-node mutex missing |
| Pulls on different nodes concurrent | ✅ Compliant | but only accidentally — same pull mode is compatible |
| Acquisition order: mode lock → node lock | ❌ NON-COMPLIANT | node lock is missing entirely |
| Deadlock-free hierarchy | ✅ Compliant | strict MUTEX_KEY → GRAPH_ACTIVITY_KEY → COMMIT_KEY |

## 7. Recommendations

1. **Add per-node pull mutex**: Introduce `PULL_NODE_KEY` and `acquireConcreteNodeLock` in `lock.js`. Acquire it inside `withPullMode` before `pullNode`, release after. This restores spec compliance and prevents wasted computation and counter inconsistency on same-node pulls.

2. **Consider LevelDB snapshots** for `listMaterializedNodes` instead of `withCommitMutex` to reduce lock contention on the commit path during inspection.

3. **No urgent action**: The missing per-node mutex has not caused observable correctness bugs in practice because the commit mutex serializes writes. The main impact is wasted computation and non-monotonic counters under concurrent same-node pulls.
