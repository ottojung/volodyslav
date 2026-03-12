# Mutex Yield: `withMutex` / `withoutMutex`

## Problem

The incremental graph serialises every `pull()` and `invalidate()` call through
a single global mutex (`MUTEX_KEY`).  This prevents two concurrent graph
operations from corrupting shared mutable state (the in-memory node cache, the
LevelDB batch, etc.).

However, some node computors perform **external I/O** that is slow and has no
side-effects on the in-memory graph:  AI calorie estimation and audio
transcription can each take several seconds.  While such a computor holds the
mutex, every concurrent `pull()` from any other HTTP request is blocked —
including cheap reads like fetching a single event by ID.

This causes what the user observes as *sequential loading*: the "Additional
Properties" spinner finishes first, and only then the "Media" spinner resolves,
even though both network requests were started at the same time.

## Solution

Introduce a **cooperative yield primitive** — `withoutMutex(key, procedure)` —
that can be called from inside a `withMutex` callback to temporarily release
the mutex, run a procedure without holding it, and then re-acquire the mutex
before returning.

```
withMutex(KEY, async () => {
    // graph bookkeeping — mutex is held
    const computedValue = await withoutMutex(KEY, () =>
        expensiveComputor(inputs, oldValue)   // released during this call
    );
    // write result back — mutex is held again
});
```

## Contract

### `withMutex(key, procedure)`
* Waits until no other holder holds `key`, then runs `procedure` exclusively.
* The mutex is released (and the next waiter unblocked) when `procedure`'s
  promise settles (resolved *or* rejected).
* Nesting `withMutex(key, …)` inside another `withMutex(key, …)` callback for
  the **same** key causes a deadlock and must be avoided.

### `withoutMutex(key, procedure)`
* **MUST** be called from within an active `withMutex(key, …)` callback.
  Calling it when the mutex for `key` is not currently held throws immediately.
* Releases the mutex so that other callers of `withMutex(key, …)` may
  proceed concurrently.
* Runs `procedure`.
* Re-acquires the mutex before returning (waits like any new `withMutex`
  caller would).
* Whether `procedure` resolves or rejects, the mutex is **always** re-acquired
  before the result/error propagates to the caller.
* Nesting `withoutMutex` inside another `withoutMutex` is prohibited: when the
  mutex is not held (because the outer `withoutMutex` released it), calling
  `withoutMutex` again throws.

## Safety Analysis

### What `withoutMutex` protects

The graph operates in two logical phases per `pull()` invocation:

1. **Graph phase** (mutex held) — traverse the dependency graph, check
   freshness, fetch input values from the DB.  This phase reads and writes
   the in-memory node cache and the LevelDB batch; concurrent access would
   corrupt it.

2. **Computor phase** (mutex released via `withoutMutex`) — call the user-
   supplied computor with pre-fetched input values.  The computor receives
   plain JavaScript values (not live graph state) and returns a new value.  It
   does *not* interact with the graph internals.

3. **Write-back phase** (mutex re-acquired) — store the computed value and
   update node metadata.  Back under the mutex.

### Can another operation corrupt the running computation?

While the computor executes without the mutex, other `pull()` or `invalidate()`
calls may run.  The computor only holds references to the input values it was
called with (plain, immutable JS values).  It cannot be corrupted by concurrent
graph mutations.

### Can the write-back produce a stale cache entry?

Yes, in theory: while the computor runs, another operation could invalidate the
same node.  The re-acquired write-back would then store a value computed from
inputs that have since changed.

However, this is **safe** under the existing cache semantics:

* Any `pull()` that runs after the invalidation will see the node as
  `"potentially-outdated"` and will recompute it, overwriting the stale entry.
* The only effect is one extra recomputation — the correctness invariant
  ("a cached value is always consistent with its inputs at the moment it is
  read") is preserved because a subsequent `pull()` always re-checks inputs.

For **side-effectful computors** (AI calls), this means the AI call might
occasionally be made twice if a concurrent invalidation races with the
write-back.  That is an acceptable tradeoff: the alternative (holding the mutex
for the full AI round-trip) blocks all reads for seconds.

## Usage in the Incremental Graph

`recompute.js` wraps every call to `nodeDefinition.computor` with
`withoutMutex`:

```javascript
const computedValue = await withoutMutex(incrementalGraph.sleeper, () =>
    nodeDefinition.computor(inputValues, oldValue)
);
```

This is the **only** permitted use of `withoutMutex` in the graph.

## Implementation

```
mutexes: Map<string, { promise: Promise<void>, releaseRef: { fn: () => void } }>
```

Each entry stores the lock promise (for waiters to `await`) and a **mutable**
`releaseRef` object (so the outer `withMutex` always releases whatever lock is
current, even if `withoutMutex` replaced the original lock during re-acquisition).

### `withMutex` outline

1. Spin-wait until no entry for `key`.
2. Allocate `releaseRef = { fn: noop }`.
3. Create a new lock promise, store `releaseRef.fn = resolve`.
4. Insert `{ promise, releaseRef }` into `mutexes`.
5. Run `procedure()`.
6. In `finally`: `mutexes.delete(key)`, then `releaseRef.fn()`.

### `withoutMutex` outline

1. Look up `entry = mutexes.get(key)`.  If absent, throw.
2. Destructure `releaseRef` from `entry`.
3. Remove entry from `mutexes`; call `releaseRef.fn()` — waiters unblock.
4. Run `procedure()`.
5. In `finally` (always executes):
   a. Spin-wait until no entry for `key` (re-acquire queue position).
   b. Create a new lock promise; set `releaseRef.fn = resolve` (updates the
      reference held by the outer `withMutex`'s `finally` block).
   c. Insert `{ promise, releaseRef }` into `mutexes`.
6. Return (or rethrow).
