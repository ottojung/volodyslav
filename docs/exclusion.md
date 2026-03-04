# In-Process Exclusion

Volodyslav uses a lightweight in-process mutex to prevent concurrent operations
from interleaving in ways that would corrupt shared mutable state.  The
mechanism is implemented in `backend/src/sleeper.js` and relies on the
[unique functor](./unique_functor.md) identity system for collision-free key
management.

---

## Overview

```javascript
await capabilities.sleeper.withMutex(key, async () => {
    // only one concurrent caller per key runs here at a time
});
```

`withMutex` serialises all concurrent calls that share the same `key`.  A caller
that arrives while another is executing will wait, then run once the first one
finishes.  There is no starvation: callers are served in arrival order.

---

## Why `UniqueTerm`, Not a String?

Earlier versions of the codebase passed raw strings to `withMutex`.  The problem
with strings is:

- **Silent collision**: two independent subsystems that happen to choose the same
  string will accidentally share a lock, serialising work that should run in
  parallel.
- **No compile-time safety**: nothing stops a typo or name reuse.

`UniqueTerm` keys are derived from `UniqueFunctor` objects that are registered
globally at module-load time.  If two modules try to register the same functor
name, the process crashes immediately with a clear error—long before any request
is served.  See [unique_functor](./unique_functor.md) for details.

---

## How `withMutex` Works

The implementation in `sleeper.js` keeps a `Map<string, () => Promise<unknown>>`
of active hold-promises, keyed by `key.serialize()`.

```
withMutex(key, procedure)
  │
  ├─ serialize key → stringKey
  │
  ├─ spin-wait: while mutexes.get(stringKey) is defined,
  │             await the existing promise
  │             (re-check after each await in case of pile-up)
  │
  ├─ register a memconst-wrapped promise under stringKey
  │
  ├─ execute procedure()
  │
  └─ finally: delete stringKey from the map
```

The `memconst` wrapper ensures that multiple waiters who started waiting at the
same time all await the *same* promise object, so they are all woken up together
when the holder finishes.  Then only the first one to re-check the map will
actually proceed; the others loop and wait again if a new holder has already
registered.

---

## Defining Mutex Keys

### Per-resource key (parameterised functor)

Use this when the lock must be per-resource (e.g., per repository path).  The
functor is created once at module scope; a new term is instantiated per call
with the resource identifier as the argument.

```javascript
// backend/src/gitstore/mutex.js
const { makeUniqueFunctor } = require("../unique_functor");

const gitStoreFunctor = makeUniqueFunctor("gitstore-operation");

function gitStoreMutexKey(workingPath) {
    return gitStoreFunctor.instantiate([workingPath]);
}
```

Two calls with different `workingPath` values hold independent locks and run
concurrently.  Two calls with the same path are serialised.

### Global singleton key (zero-argument term)

Use this when an entire subsystem should be single-threaded, regardless of
which resource is involved.  Instantiate the term once, also at module scope.

```javascript
// backend/src/generators/incremental_graph/lock.js
const { makeUniqueFunctor } = require("../../unique_functor");

const MUTEX_KEY = makeUniqueFunctor("incremental-graph-operations").instantiate([]);

function withMutex(sleeper, procedure) {
    return sleeper.withMutex(MUTEX_KEY, procedure);
}
```

Wrapping the `withMutex` call in a local function is the recommended pattern:
it keeps callers decoupled from the key and makes the lock easier to find.

---

## Exclusion Points in the Codebase

| Module | Lock scope | Protects |
|---|---|---|
| `backend/src/gitstore/mutex.js` | Per `workingPath` | `checkpoint()` and `transaction()` on the same local repository |
| `backend/src/generators/incremental_graph/lock.js` | Global (per `IncrementalGraph` sleeper instance) | `invalidate()`, `pull()`, and `runMigration()` in the incremental graph engine |

---

## What It Does Not Protect Against

`withMutex` is an **in-process** mechanism only.  It serialises concurrent
async operations within a single Node.js event loop.

It does *not* protect against:

- **Multiple processes** on the same machine accessing the same resource.
- **Multiple hosts** (e.g., in a distributed deployment).

Cross-process and cross-host conflicts in the gitstore are handled separately by
the push-and-retry loop in `transaction_retry.js`: if two processes try to push
at the same time, one gets a `PushError` and retries from the top of the
attempt loop.  See [gitstore](./gitstore.md) for details.

---

## Interaction Between Exclusion Levels

For the `gitstore` subsystem, both layers are active:

```
in-process mutex (withMutex)
    │  serialises concurrent calls within one process
    ↓
temp-clone → transform → push to local working copy
    │  concurrent pushes from different processes...
    ↓
push-and-retry loop
    │  ...are resolved by re-fetching and re-applying
    ↓
authoritative remote store
```

The mutex makes the retry loop cheaper: within a process, only one attempt runs
at a time, so the number of actual push conflicts between processes is reduced.
