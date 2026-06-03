# Issue 3.4 Report: Invalidation and Observe Mode Exclusivity

**Question:** Does `withObserveMode` properly exclude `withPullMode`? Can an invalidation run concurrently with a pull on the same graph?

---

## Lock Primitives (lock.js)

Three mode-mutex wrappers on `GRAPH_ACTIVITY_KEY`:

| Function | Mode | Call |
|---|---|---|
| `withObserveMode` | `"observe"` | `sleeper.withModeMutex(GRAPH_ACTIVITY_KEY, "observe", procedure)` |
| `withPullMode` | `"pull"` | `sleeper.withModeMutex(GRAPH_ACTIVITY_KEY, "pull", procedure)` |
| `withExclusiveMode` | `"exclusive"` | `MUTEX_KEY` → `sleeper.withModeMutex(GRAPH_ACTIVITY_KEY, "exclusive", procedure)` |

## Mode Mutex Semantics (sleeper.js:92-97)

```javascript
const canEnterImmediately =
    entry.queue.length === 0 &&
    (
        entry.activeCount === 0 ||
        entry.activeMode === mode
    );
```

- Different modes for the **same key** are **mutually exclusive**.
- Same-mode callers may run **concurrently** (activeCount tracks them).

## Call Paths

### Pull path
```
internalSafePullWithStatus
  → withPullMode(sleeper, procedure)           // GRAPH_ACTIVITY_KEY("pull")
    → pullNode
      → withPullNodeMutex(nodeKeyStr)           // per-node mutex (different key)
        → withTransaction
          → withCommitMutex(replicaName)        // COMMIT_KEY(replica)
```

### Invalidate path (public API)
```
internalInvalidate
  → withObserveMode(sleeper, procedure)         // GRAPH_ACTIVITY_KEY("observe")
    → internalUnsafeInvalidate
      → withTransaction
        → withCommitMutex(replicaName)          // COMMIT_KEY(replica)
```

## Analysis

Both paths acquire `GRAPH_ACTIVITY_KEY` with different modes:
- Pull acquires it in `"pull"` mode.
- Invalidate acquires it in `"observe"` mode (via `internalInvalidate`).

Since `"pull"` ≠ `"observe"`, and the `withModeMutex` implementation blocks entry when `activeMode !== requestedMode`, **they are properly exclusive**:

- If a pull is running (activeCount > 0, activeMode = "pull"), an invalidate call will wait at `withObserveMode` until the pull completes.
- If an invalidate is running (activeCount > 0, activeMode = "observe"), a pull call will wait at `withPullMode` until the invalidation completes.

**The `unsafeInvalidate` method** (`class.js:135`) bypasses `withObserveMode` — callers must hold the observe mode lock themselves. This is intentional (the "unsafe" prefix signals the contract).

## Lock Acquisition Order

Both paths follow the same order within the graph activity scope:
```
GRAPH_ACTIVITY_KEY(mode) → COMMIT_KEY(replicaName)
```

There is no lock-ordering inversion because `withObserveMode` and `withPullMode` cannot nest inside each other, and neither nests inside a commit-mutex scope.

## Conclusion

**No issue found.** `withObserveMode` and `withPullMode` are properly exclusive on `GRAPH_ACTIVITY_KEY`. An invalidation cannot run concurrently with a pull on the same graph. The review plan's concern is addressed by the existing implementation.
