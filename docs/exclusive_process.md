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
  └─ invoke(arg, cb?) ─ second caller → conflictor decides:
                                         "attach" → coalesces onto running run
                                         "queue"  → waits for a fresh run
```

When the procedure calls `fanOut(event)`, every registered caller callback
receives the event — including callbacks from attachers that joined after
the run started.

After the computation finishes (success *or* error) the `ExclusiveProcess`
resets to idle, so the next `invoke` starts a fresh run.

---

## API

### `makeExclusiveProcess<A, T, C>({ initialState, procedure, conflictor, getCapabilities }) → ExclusiveProcess<A, T, C>`

Creates a new, idle `ExclusiveProcess`.

**`procedure(fanOut, arg)`** — the async computation to run.  Must return a
`Promise<T>`.

- `fanOut: (cbArg: C) => void` — class-managed wrapper; call this to
  broadcast progress events to all current callers.  If a caller's callback
  throws, the error is caught and logged via `capabilities.logger.logError`
  via the capabilities returned by `getCapabilities`; fan-out continues to the
  remaining callbacks uninterrupted.
- `arg: A` — per-invocation argument passed by the caller.

The procedure is called fresh on each new run.

**`conflictor(initiating, attaching) → "attach" | "queue"`** — called when
`invoke` arrives while a run is already in progress.

- Return `"attach"` to coalesce the new call onto the current run.  The
  new caller's `callerCallback` is added to the fan-out list and the new
  caller shares the current run's result promise.
- Return `"queue"` to queue the new call behind the current run.  The
  new caller waits for a fresh run that starts after the current one ends.

To always attach (never queue), pass `conflictor: () => "attach"`.

**`getCapabilities(arg) → { logger, ... }`** — called at the start of each
run to obtain a capabilities object used for subscriber error reporting.
Receives the same `arg` that was passed to `invoke`, so capabilities embedded
in the arg can be used:
`getCapabilities: ({ capabilities }) => capabilities`.

---

### `exclusiveProcess.invoke(arg, callerCallback?) → ExclusiveProcessHandle<T>`

| State before call | `conflictor` decision | Behaviour |
|---|---|---|
| Idle | — | Starts the run with `arg`; caller is the *initiator* |
| Running | `"attach"` | Attaches; caller becomes an *attacher* |
| Running | `"queue"` | Queues behind the current run |

`callerCallback` is registered in the class-managed fan-out list for the
current run (or for the queued run, if queuing).  It will be called every
time the procedure calls `fanOut(event)` for the remainder of the run.

**Queuing semantics (when `conflictor` returns `"queue"`)**:
- Last-write-wins on `arg`: the most-recently queued `arg` is used when the
  queued run starts.
- All queued callers' callbacks are **composed**: every queued caller receives
  fan-out events from the queued run, even if their `arg` was overwritten.

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
const ep = makeExclusiveProcess({
    initialState: undefined,
    procedure: (fanOut, arg) => {
        fanOut("step-1");
        fanOut("step-2");
        return Promise.resolve("done");
    },
    conflictor: () => "attach",
    getCapabilities: (arg) => arg,
});

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
const ep = makeExclusiveProcess({
    initialState: undefined,
    procedure: (_fanOut, _arg) => Promise.reject(new Error("oops")),
    conflictor: () => "attach",
    getCapabilities: (arg) => arg,
});

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
const ep = makeExclusiveProcess({
    initialState: undefined,
    procedure: (_fanOut, _arg) => Promise.reject(new Error("first failure")),
    conflictor: () => "attach",
    getCapabilities: (arg) => arg,
});
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

Non-parametric dependencies (such as `capabilities`) can be included in the
`arg` object.  The `conflictor` should inspect only the fields that matter for
queuing and ignore the rest.

```javascript
// backend/src/jobs/diary_summary.js
const { makeExclusiveProcess } = require("../exclusive_process");

/**
 * @typedef {{ type: "entryQueued", path: string }
 *          | { type: "entryProcessed", path: string, status: "success" | "error" }
 * } DiarySummaryEvent
 */

const diarySummaryExclusiveProcess = makeExclusiveProcess({
    // procedure receives fanOut and arg directly
    procedure: (fanOut, { capabilities }) => {
        return _runPipelineUnlocked(capabilities, {
            onEntryQueued:    (path)         => fanOut({ type: "entryQueued", path }),
            onEntryProcessed: (path, status) => fanOut({ type: "entryProcessed", path, status }),
        });
    },
    // All concurrent calls attach to the same run — no queuing needed.
    conflictor: () => "attach",
    getCapabilities: ({ capabilities }) => capabilities,
});

function runDiarySummaryPipeline(capabilities, callbacks) {
    const callerCallback = callbacks
        ? (event) => {
            if (event.type === "entryQueued")    callbacks.onEntryQueued?.(event.path);
            else if (event.type === "entryProcessed") callbacks.onEntryProcessed?.(event.path, event.status);
          }
        : undefined;
    return diarySummaryExclusiveProcess.invoke({ capabilities }, callerCallback).result;
}

module.exports = { runDiarySummaryPipeline, diarySummaryExclusiveProcess };
```

### Options queuing (sync use-case)

When different callers may supply incompatible arguments, use `conflictor` to
ensure conflicting calls are never silently dropped:

```javascript
// backend/src/sync/index.js
const synchronizeAllExclusiveProcess = makeExclusiveProcess({
    procedure: (fanOut, { capabilities, options }) => {
        return _synchronizeAllUnlocked(capabilities, options, fanOut);
    },
    // conflictor ignores capabilities; only inspects resetToHostname
    conflictor: (initiating, attaching) => {
        const incomingReset = attaching.options?.resetToHostname;
        if (incomingReset === undefined) return "attach";
        return incomingReset !== initiating.options?.resetToHostname ? "queue" : "attach";
    },
    getCapabilities: ({ capabilities }) => capabilities,
});

function synchronizeAll(capabilities, options, onStepComplete) {
    return synchronizeAllExclusiveProcess.invoke({ capabilities, options }, onStepComplete).result;
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
