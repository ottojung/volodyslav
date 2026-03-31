# ExclusiveProcess

`ExclusiveProcess` is an in-process primitive that ensures a named async
computation runs *at most once at a time* while still being invocable from
many independent call-sites, and forwards per-run progress events to all
concurrent callers through a built-in callback fan-out.

---

## Motivation

Several long-running operations in Volodyslav can be triggered from two
independent places:

| Operation | Triggered by scheduled job | Triggered by frontend |
|---|---|---|
| Diary-summary pipeline | hourly job in `jobs/all.js` | POST `/diary-summary/run` |
| Sync | hourly job in `jobs/all.js` | POST `/sync` |

Before `ExclusiveProcess` existed, these two trigger-paths were completely
independent.  A second concurrent invocation could therefore:

1. Start a parallel run (wasting resources and potentially corrupting shared
   state), or
2. Queue a redundant run via the old mutex (so the operation ran twice in
   sequence even though only one run was needed).

---

## Concept

An `ExclusiveProcess` wraps a single, re-runnable async computation with
three type parameters:

- **`A`** — type of the single argument accepted by each invocation.
- **`T`** — return type of the computation.
- **`C`** — type of each progress event broadcast by the computation.

```
ExclusiveProcess<A, T, C>
  │
  ├─ invoke(arg, cb?) ─ first caller  → starts run, becomes INITIATOR
  │                                     cb registered in fan-out list
  │
  └─ invoke(arg, cb?) ─ second caller → attaches (or queues, see below)
                                        cb registered in same fan-out list
                                        both handles share the same result promise
```

When the procedure calls `fanOut(event)`, every registered caller callback
receives the event — not just the one who started the run.

After the computation finishes (success *or* error) the `ExclusiveProcess`
resets to idle, so the next `invoke` starts a fresh run.

---

## API

### `makeExclusiveProcess<A, T, C>(procedure, shouldQueue?) → ExclusiveProcess<A, T, C>`

Creates a new, idle `ExclusiveProcess`.

**`procedure`** is a curried function:

```
(fanOut: (cbArg: C) => void) => (arg: A) => Promise<T>
```

The class calls `procedure(fanOut)` once (at construction of the inner
function) and then invokes the returned function with the caller's `arg` on
each run.  `fanOut` is a class-managed wrapper that distributes each emitted
event to all currently registered caller callbacks.

**`shouldQueue`** `(currentArg: A, newArg: A) => boolean` (optional) —
if provided and returns `true` for a pair of `(currentArg, newArg)`, the new
invocation is *queued* behind the current run rather than *attached* to it.
Last-write-wins when multiple calls are queued during the same run.

---

### `exclusiveProcess.invoke(arg, callerCallback?) → ExclusiveProcessHandle<T>`

| State before call | Behaviour |
|---|---|
| Idle | Starts the run with `arg`; caller is the *initiator* |
| Running, compatible | Attaches; caller becomes an *attacher* |
| Running, conflicting (`shouldQueue` returns `true`) | Queues behind the current run |

`callerCallback` is registered in the class-managed fan-out list for the
current run (or for the queued run, if queuing).  It will be called every
time the procedure calls `fanOut(event)` for the remainder of the run.

---

### `handle.isInitiator: boolean`

`true` if this particular call started the computation; `false` if it attached
to an already-running one (or is waiting for a queued run).

---

### `handle.result: Promise<T>`

A promise shared by the initiator and all attachers for the same run.  It
resolves with the return value of the procedure on success, or rejects with
the thrown error on failure.

---

## Guarantees

### Progress events reach all concurrent callers

Because all handles for the same run share the same fan-out list, every event
emitted via `fanOut` is delivered to every registered callback — including
callbacks registered by attachers that joined after the run started.

```javascript
const ep = makeExclusiveProcess(
    (fanOut) => (arg) => {
        fanOut("step-1");
        fanOut("step-2");
        return Promise.resolve("done");
    }
);

const steps1 = [];
const steps2 = [];

const h1 = ep.invoke(undefined, (e) => steps1.push(e)); // initiator
const h2 = ep.invoke(undefined, (e) => steps2.push(e)); // attacher

await Promise.all([h1.result, h2.result]);

// Both callers received every event
console.log(steps1); // ["step-1", "step-2"]
console.log(steps2); // ["step-1", "step-2"]
```

### Errors propagate to all callers

Because all handles (initiator + every attacher) share the same `Promise`
object, a rejection is seen by every awaiter — not just the one that started
the computation.

```javascript
const ep = makeExclusiveProcess(
    (_fanOut) => (_arg) => Promise.reject(new Error("oops"))
);

const h1 = ep.invoke(undefined); // initiator
const h2 = ep.invoke(undefined); // attacher

await Promise.all([
    h1.result.catch(e => console.error("h1:", e.message)), // "oops"
    h2.result.catch(e => console.error("h2:", e.message)), // "oops"
]);
```

### Errors do not prevent future runs

`_currentPromise` is cleared in the rejection handler *before* the rejection
propagates, so the next `invoke` always sees the process as idle and starts a
fresh computation.

```javascript
const ep = makeExclusiveProcess(
    (_fanOut) => (_arg) => Promise.reject(new Error("first failure"))
);
await ep.invoke(undefined).result.catch(() => {});
// ep is now idle again
const h = ep.invoke(undefined, ...);
console.log(h.isInitiator); // true
```

---

## Usage pattern

### Shared singleton per subsystem

Create one `ExclusiveProcess` instance per long-running operation.  The
instance must be accessible from every call-site that participates in the
exclusion (typically both the route handler *and* the scheduled job).

Capture non-parametric dependencies (such as `capabilities`) in a
module-level variable that is updated before each `invoke`, rather than
passing them through `invoke`.

```javascript
// backend/src/jobs/diary_summary.js
const { makeExclusiveProcess } = require("../exclusive_process");

let _capabilities = null;

/**
 * @typedef {{ type: "entryQueued", path: string }
 *          | { type: "entryProcessed", path: string, status: "success" | "error" }
 * } DiarySummaryEvent
 */

const diarySummaryExclusiveProcess = makeExclusiveProcess(
    // procedure: (fanOut) => (arg) => Promise<T>
    (fanOut) => (_arg) => {
        const capabilities = _capabilities;
        if (capabilities === null) throw new Error("capabilities not set");
        return _runPipelineUnlocked(capabilities, {
            onEntryQueued: (path) => fanOut({ type: "entryQueued", path }),
            onEntryProcessed: (path, status) => fanOut({ type: "entryProcessed", path, status }),
        });
    }
    // No shouldQueue — all concurrent calls attach to the same run.
);

function runDiarySummaryPipeline(capabilities, callbacks) {
    _capabilities = capabilities;
    const callerCallback = callbacks
        ? (event) => {
            if (event.type === "entryQueued") callbacks.onEntryQueued?.(event.path);
            else callbacks.onEntryProcessed?.(event.path, event.status);
          }
        : undefined;
    return diarySummaryExclusiveProcess.invoke(undefined, callerCallback).result;
}

module.exports = { runDiarySummaryPipeline, diarySummaryExclusiveProcess };
```

### Options queuing (sync use-case)

When different callers may supply incompatible arguments, use `shouldQueue` to
ensure conflicting calls are never silently dropped:

```javascript
// backend/src/sync/index.js
let _capabilities = null;

const synchronizeAllExclusiveProcess = makeExclusiveProcess(
    // procedure
    (fanOut) => (options) => {
        const capabilities = _capabilities;
        if (capabilities === null) throw new Error("capabilities not set");
        return _synchronizeAllUnlocked(capabilities, options, fanOut);
    },
    // shouldQueue: queue when resetToHostname conflicts
    (currentOptions, newOptions) => _syncOptionsConflict(currentOptions, newOptions)
);

function synchronizeAll(capabilities, options, onStepComplete) {
    _capabilities = capabilities;
    return synchronizeAllExclusiveProcess.invoke(options, onStepComplete).result;
}
```

---

## Relation to `withMutex`

`withMutex` *serialises* callers: the second caller waits for the first to
finish, then starts its own run from scratch.  `ExclusiveProcess` *coalesces*
callers: the second caller attaches to the first's run, so there is never more
than one execution.

| Property | `withMutex` | `ExclusiveProcess` |
|---|---|---|
| Max concurrent runs | 1 | 1 |
| Second caller behaviour | Queued; runs after first | Attached; shares first's result |
| Error propagation | Only to the failed run's caller | All current callers |
| Progress events | Per-caller | Shared fan-out to all callers |
| Total runs (N callers) | N | 1 |
