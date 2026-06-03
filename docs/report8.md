# Report 8: Concurrency Implementation Evaluation

Evaluates the incremental-graph locking implementation (`lock.js`, `sleeper.js`, `graph_state.js`, `pull.js`, `invalidate.js`, `inspection.js`, `graph_api.js`, `migration_runner.js`) against each concern in `docs/concurrentcy_helpful.md`.

---

## 1. Safety — "nothing bad happens"

### Data-race freedom

**Document says:** Two threads should not access the same mutable memory concurrently where at least one access is a write, unless synchronised.

**Finding:** JavaScript is single-threaded with an event loop — there are no threads and no true data races. The `async/await` pattern does allow interleaving across `await` points, which the locking system prevents by serialising critical sections.

**Verdict:** ✅ No data races possible by construction. All shared mutable state (mutex maps, mode-mutex maps) is accessed without `await` between check and set (see Atomicity below).

### Atomicity

**Document says:** Some operations need to happen as one indivisible logical step.

**Finding:**

- **`withTransaction`** (`graph_state.js`): The callback runs *outside* the commit mutex. Inside the commit mutex, the batch flush to LevelDB and identifier-lookup publication form an atomic unit (disk-first invariant: flush‑then‑publish). Revdep diffs are computed under the commit mutex from a consistent snapshot. ✅

- **`withModeMutex` entry creation** (`sleeper.js:82–90`): `get` then `set` on the `modeMutexes` Map — no `await` between them, so JS run-to-completion guarantees atomicity. ✅

- **`canEnterImmediately` check** (`sleeper.js:92–97`): `get` of `entry.queue.length`, `entry.activeCount`, `entry.activeMode` — no `await` between any of these reads and the subsequent mutation. ✅

- **`withMutex` entry creation** (`sleeper.js:50–52`): Check‑then‑set on `mutexes` Map — no `await`, so atomic. ✅

**Verdict:** ✅ All critical state transitions are atomic within the event loop.

### Invariant preservation

**Document says:** Locks protect invariants, not just variables.

**Finding:**

| Lock / Key | Invariant protected |
|---|---|
| `GRAPH_ACTIVITY_KEY` mode `"observe"` | No pull runs concurrently with invalidate or inspection read. |
| `GRAPH_ACTIVITY_KEY` mode `"pull"` | No invalidate or inspection read runs concurrently with a pull. |
| `PULL_NODE_FUNCTOR(nodeKeyStr)` | Two pulls of the same concrete node do not overlap (prevent duplicate identifier allocation, revdep corruption). |
| `COMMIT_KEY(replicaName)` | Only one transaction commits per replica at a time (serialise batch writes + identifier publication). |
| `MUTEX_KEY` | Only one exclusive operation (migration, DB open) runs at a time; CRUD critical sections (`graph_api.js`) are also serialised against exclusive mode. |

All documented in `lock.js` JSDoc. ✅

### Visibility / memory ordering

**Document says:** One thread's writes must become visible to another thread at the right time.

**Finding:**

- JavaScript's event loop provides `happens-before`: when a Promise resolves, all state modifications before the `resolve()` call are visible to the awaiter. ✅
- LevelDB handles its own write ordering within `batch()`. ✅
- The `finally` blocks in `withMutex` and `withModeMutex` release locks by deleting/resolving mutex entries, which the event loop processes in FIFO order for `withMutex` and mode-group FIFO for `withModeMutex`. ✅

**Verdict:** ✅ Standard JS event-loop guarantees apply. No memory-ordering issues.

### Linearizability / consistency of concurrent objects

**Document says:** Each operation should appear to happen at one instant between call and return.

**Finding:**

- A `pull()` cannot observe a half-finished `invalidate()` — they use different `GRAPH_ACTIVITY_KEY` modes that are mutually exclusive. ✅
- A `getValue()` (observe mode) cannot observe a half-finished `pull` (pull mode) — mutually exclusive. ✅
- `listMaterializedNodes` acquires `GRAPH_ACTIVITY_KEY("observe")` then `COMMIT_KEY` via `withCommitSnapshot` — this ensures a stable view of the materialized set. ✅
- The transaction commit is linearizable: the batch flush + identifier publication happen inside `withCommitMutex`, so no observer sees a partially committed transaction. ✅

**Verdict:** ✅ Operations are linearizable at the graph level.

---

## 2. Liveness — "something good eventually happens"

### Deadlock freedom

**Document says:** The program should not reach a state where threads wait forever for each other.

**Finding:**

The lock acquisition hierarchy is:

```
Outer ──────────────────────────────────────────────► Inner

MUTEX_KEY (optional, for exclusive ops)
  └─ GRAPH_ACTIVITY_KEY("exclusive")   [migration, DB open]

MUTEX_KEY (for CRUD sync in graph_api.js)
  └─ GRAPH_ACTIVITY_KEY("observe")     [invalidate]
  └─ GRAPH_ACTIVITY_KEY("pull")        [pull, via internalUpdate]
       └─ PULL_NODE_FUNCTOR(node)      [per-node pull]
            └─ COMMIT_KEY(replica)     [commit phase]

GRAPH_ACTIVITY_KEY("observe")           [inspection reads, invalidate]
  └─ COMMIT_KEY(replica)               [listMaterializedNodes]

GRAPH_ACTIVITY_KEY("pull")              [top-level pull]
  └─ PULL_NODE_FUNCTOR(node)           [per-node]
       └─ PULL_NODE_FUNCTOR(dep)       [recursive: dependency pull]
            └─ COMMIT_KEY(replica)     [commit phase]
```

Key observations:

1. **No cycle between MUTEX_KEY and GRAPH_ACTIVITY_KEY**: these are independent keys; `withExclusiveMode` acquires MUTEX_KEY first, then GRAPH_ACTIVITY_KEY("exclusive"). CRUD (`graph_api.js`) acquires MUTEX_KEY first, then GRAPH_ACTIVITY_KEY inside. Neither ever acquires in the opposite order. ✅

2. **No cycle within GRAPH_ACTIVITY_KEY modes**: "observe" and "pull" are mutually exclusive by design, so a cycle would require a thread holding "observe" to try to acquire "pull" (or vice versa). Neither path does this. ✅

3. **Recursive pulls** (`PULL_NODE_FUNCTOR(dep)` while holding `PULL_NODE_FUNCTOR(parent)`): The graph is a DAG (enforced by `validateAcyclic` in `class.js`). A deadlock would require a dependency cycle `A→B→A`, which the constructor rejects. ✅

4. **`withMutex` spin-wait** (`sleeper.js:49–54`): `for(;;) { await existing.promise }` — if the promise never resolves, this spins forever. All mutexes are released in `finally` blocks, so no unreleased mutex can strand a waiter. If the process itself crashes, the JS runtime terminates and all waiters are freed. ✅

**Verdict:** ✅ Deadlock-free under the documented acquisition discipline.

### Starvation freedom

**Finding:**

- `withModeMutex` uses FIFO mode-group scheduling. When a mode's last active caller finishes, the first waiter (any mode) is dequeued and all same-mode waiters behind it are batched in. **Continuous** callers of one mode could starve the other mode if the active mode never quiesces — there is no fairness barrier. ⚠️

- `withMutex` uses strict FIFO: each caller waits on the previous holder's promise. No starvation. ✅

**Verdict:** ⚠️ **Theoretically possible** under continuous load of one mode (e.g., relentless pulls starving an invalidate). In practice the application is a personal tool with a non-adversarial single user, so this is acceptable. Noted.

### Livelock freedom

**Finding:** No CAS loops, retry patterns, or "polite stepping aside" — the system uses blocking mutexes only. No livelock path exists. ✅

**Verdict:** ✅

### Fairness

| Primitive | Fairness |
|---|---|
| `withMutex` | Strict FIFO per key. |
| `withModeMutex` | FIFO mode-group: the first waiter in the queue is always the next to run, but all subsequent same-mode waiters are batched in at once (they skip ahead of enqueued conflicting-mode callers). |
| `withTransaction` commit | `withCommitMutex` is strict FIFO per replica. |

**Verdict:** ✅ Sufficient for purpose. Mode batching slightly favours the current mode, but no caller is skipped indefinitely because the queue head is always served next.

### Bounded waiting

**Finding:** Not guaranteed. A sustained stream of pull callers could prevent an invalidate from ever acquiring `GRAPH_ACTIVITY_KEY`.

**Verdict:** ⚠️ Noted as a pre-existing limitation. Not a practical concern for a single-user application.

### Progress guarantees

**Finding:** The system uses blocking mutexes (`withMutex`, `withModeMutex`). Progress requires the holder to release the lock. This is the weakest guarantee in the lock-free hierarchy but is standard and simplest for this application.

**Verdict:** ✅ Acceptable.

---

## 3. Resource management

### Lock ordering

**Document says:** Have a global policy: "locks are acquired in this order."

**Finding:** The order is documented in `lock.js` and in the spec `docs/specs/incremental-graph-locking-design.md`. Every code path follows:
1. `GRAPH_ACTIVITY_KEY` mode (for graph ops) or `MUTEX_KEY` (for exclusive ops)
2. `PULL_NODE_FUNCTOR` (only inside `"pull"` mode)
3. `COMMIT_KEY` (only during transaction commit)

No code path violates this order. ✅

**Verdict:** ✅ Well-documented and consistently enforced.

### Lock granularity

| Lock | Granularity | Purpose |
|---|---|---|
| `GRAPH_ACTIVITY_KEY` | Global (mode) | Prevents pull↔observe mixing; allows same-mode concurrency. |
| `PULL_NODE_FUNCTOR(nodeKeyStr)` | Per-node | Serialises same-node pulls without blocking different-node pulls. |
| `COMMIT_KEY(replicaName)` | Per-replica | Serialises transaction commit (batch + identifier publication). |
| `MUTEX_KEY` | Global (exclusive) | Serialises migrations, DB opens, and CRUD critical sections. |

**Verdict:** ✅ Three-tier granularity is well-chosen. The mode-mutex avoids a global exclusive lock for all graph activity.

### Critical section size

| Lock | What is inside | Assessment |
|---|---|---|
| `GRAPH_ACTIVITY_KEY` (mode) | Entire pull, invalidate, or inspect operation | Necessary for correctness — dropping the lock mid-pull would allow conflicting operations. ⚠️ Note: I/O (LevelDB reads) happens inside. |
| `PULL_NODE_FUNCTOR` | The `pullNode` body: freshness check, full compute, transaction commit | Necessary — the per-node mutex must cover creation of the Transaction through its commit. |
| `COMMIT_KEY` | Batch flush + identifier publication only | Minimal — the transaction callback runs *outside* this mutex. ✅ |
| `MUTEX_KEY` (CRUD) | In-memory update + invalidate + pull | Prevents `synchronizeDatabase` from running between invalidate and pull (which would clear `_incrementalGraph`). ✅ |

**Verdict:** ✅ Critical sections are appropriately scoped. The `COMMIT_KEY` scope is notably minimal (disk flush only).

### Cancellation and shutdown

**Finding:** There is no mechanism to cancel pending mutex waiters during shutdown. If the process exits, all waiters are freed by the runtime. If a graceful shutdown is attempted while waiters are queued, they will wait forever unless something wakes them.

**Verdict:** ⚠️ Noted. Not a concern for the current application (personal tool, process-level shutdown terminates everything).

### Timeouts

**Finding:** No timeout is applied to any mutex acquisition. All waits are indefinite.

**Verdict:** ✅ Intentional — matches the non-adversarial client policy. Timeouts would turn deadlocks into partial failures without improving correctness.

### Backpressure

**Finding:** Not applicable — this is not a producer-consumer system.

**Verdict:** ✅

---

## 4. Performance issues

### Contention

**Finding:**
- Same-node pulls contend on `PULL_NODE_FUNCTOR` — necessary and correct.
- Different-node pulls share `GRAPH_ACTIVITY_KEY("pull")` mode but run concurrently (mode-mutex allows concurrency within same mode).
- Invalidates and inspection reads share `GRAPH_ACTIVITY_KEY("observe")` mode — concurrent.
- Exclusive mode (`MUTEX_KEY`) is acquired only during migration, which is rare.

**Verdict:** ✅ Low contention by design. Only same-node pulls and mode switches are serialization points.

### Amdahl's law

**Finding:** The sequential bottleneck is `COMMIT_KEY` (per-transaction commit). Recursive dependency pulls commit one at a time. For a graph with deep dependency chains, this sequential part dominates.

**Verdict:** ✅ Acceptable for a personal tool with modest graph sizes.

### Priority inversion / false sharing / oversubscription / load balancing

**Finding:** Not applicable in single-threaded JS.

**Verdict:** ✅

---

## 5. Reasoning and design discipline

### Minimize shared mutable state

**Finding:**
- Each `Transaction` has its own batch overlay — no shared batch state between transactions. ✅
- The identifier lookup uses a base‑overlay pattern: `TransactionIdentifierLookup` has a read-only reference to the committed `base`, with new allocations in the overlay. The base is mutated only at commit time, after disk flush. ✅
- `ConcreteNodeCache` (LRU) is the one piece of shared mutable state outside the lock regimen — it is read/write from inside `withPullNodeMutex`. Cache misses during a pull could cause redundant deserialization work but not incorrectness. ✅

**Verdict:** ✅ Well-structured. Shared state is minimized and each piece has a clear protecting lock.

### Concurrency contract

**Document says:** For each shared object, write a tiny "concurrency contract."

**Finding:**

| Object | Protected by | Invariant | Callbacks while locked |
|---|---|---|---|
| `mutexes` map | JS run-to-completion | Each key has at most one running procedure. | None |
| `modeMutexes` map | JS run-to-completion | Same mode → concurrent; different mode → exclusive. | None |
| Transaction batch | `COMMIT_KEY` | Batch flushed before identifier publication. | None |
| `_computed.identifierLookup` | `COMMIT_KEY` (publication) + `OBSERVE_MUTEX` (reads) | In-memory match disk state. | None |

Explicit JSDoc on each function in `lock.js` and `graph_state.js`. ✅

**Verdict:** ✅

---

## Summary of findings

| Category | Concern | Status | Notes |
|---|---|---|---|
| Safety | Data-race freedom | ✅ | JS single-threaded by construction |
| Safety | Atomicity | ✅ | No `await` between check and set |
| Safety | Invariant preservation | ✅ | Clear lock-to-invariant mapping |
| Safety | Visibility / memory ordering | ✅ | Event-loop guarantees |
| Safety | Linearizability | ✅ | Mutually exclusive modes + serialized commit |
| Liveness | Deadlock freedom | ✅ | Hierarchical acquisition; DAG prevents recursive cycles |
| Liveness | Starvation freedom | ⚠️ | Possible under continuous same-mode load; acceptable |
| Liveness | Livelock freedom | ✅ | No CAS/retry patterns |
| Liveness | Fairness | ✅ | FIFO mutex; FIFO mode-group |
| Liveness | Bounded waiting | ⚠️ | Not guaranteed; acceptable |
| Liveness | Progress guarantees | ✅ | Blocking mutexes (sufficient) |
| Resource | Lock ordering | ✅ | Spec-compliant; documented |
| Resource | Lock granularity | ✅ | Three-tier: global mode → per-node → per-replica |
| Resource | Critical section size | ✅ | Commit mutex minimal; mode mutex covers operation (necessary) |
| Resource | Cancellation / shutdown | ⚠️ | No cancel mechanism; acceptable |
| Resource | Timeouts | ✅ | No timeouts (intentional) |
| Resource | Backpressure | ✅ | N/A |
| Performance | Contention | ✅ | Same-node only; modes allow concurrency |
| Performance | Amdahl's law | ✅ | Commit is sequential bottleneck; acceptable |
| Design | Minimize shared state | ✅ | Base-overlay pattern; per-transaction batches |
| Design | Concurrency contract | ✅ | Documented JSDoc + spec |

**Overall verdict:** The implementation is correct, well-documented, and follows the spec. The two ⚠️ findings (starvation, cancellation) are acknowledged limitations that do not affect the target use case.
