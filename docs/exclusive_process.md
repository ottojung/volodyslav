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
- **`S`** — type of the shared state and of the payload delivered to subscriber callbacks.

```
ExclusiveProcess<A, T, S>
  │
  ├─ invoke(cap, arg, cb?) ─ first caller  → starts run, becomes INITIATOR
  │                                          cb registered in fan-out list
  │
  └─ invoke(cap, arg, cb?) ─ second caller → conflictor decides:
                                             "attach" → coalesces onto running run
                                             "queue"  → waits for a fresh run
```

When the procedure calls `mutateState(fn)`, every registered caller callback
receives the new state — including callbacks from attachers that joined after
the run started.

After the computation finishes (success *or* error) the `ExclusiveProcess`
resets to idle, so the next `invoke` starts a fresh run.

---

## API

### `makeExclusiveProcess<A, T, S>({ initialState, procedure, conflictor }) → ExclusiveProcess<A, T, S>`

Creates a new, idle `ExclusiveProcess`.

**`procedure(mutateState, arg)`** — the async computation to run.  Must return a
`Promise<T>`.

- `mutateState: (fn: (state: S) => S | Promise<S>) => Promise<void>` — class-managed
  wrapper; call this to update shared state and notify all current subscribers.
  If a subscriber throws or returns a rejected promise, the error is caught and
  logged via `capabilities.logger.logError` using the capabilities supplied to
  `invoke`; fan-out continues to the remaining subscribers uninterrupted.
- `arg: A` — per-invocation argument passed by the caller.

The procedure is called fresh on each new run.  It retrieves the current
capabilities via `exclusiveProcessInstance.getCapabilities()`, referencing the
outer-scope instance:

```js
const ep = makeExclusiveProcess({
    initialState: undefined,
    procedure: (mutateState) => {
        const capabilities = ep.getCapabilities();
        // use capabilities...
    },
    conflictor: () => "attach",
});

function run(capabilities) {
    return ep.invoke(capabilities, undefined).result;
}
```

**`conflictor(initiating, attaching) → "attach" | "queue"`** — called when
`invoke` arrives while a run is already in progress.

- Return `"attach"` to coalesce the new call onto the current run.  The
  new caller's `callerCallback` is added to the fan-out list and the new
  caller shares the current run's result promise.
- Return `"queue"` to queue the new call behind the current run.  The
  new caller waits for a fresh run that starts after the current one ends.

To always attach (never queue), pass `conflictor: () => "attach"`.

---

### `exclusiveProcess.invoke(capabilities, arg, callerCallback?) → ExclusiveProcessHandle<T>`

| State before call | `conflictor` decision | Behaviour |
|---|---|---|
| Idle | — | Starts the run with `capabilities` and `arg`; caller is the *initiator* |
| Running | `"attach"` | Attaches; caller becomes an *attacher* |
| Running | `"queue"` | Queues behind the current run |

`capabilities` is stored on the instance for the duration of the run and is
accessible via `exclusiveProcess.getCapabilities()`.

`callerCallback` is registered in the class-managed state-update fan-out list
for the current run (or for the queued run, if queuing).  It will be called
every time the procedure calls `mutateState` for the remainder of the run.

**Queuing semantics (when `conflictor` returns `"queue"`)**:
- Last-write-wins on `arg` and `capabilities`: the most-recently queued values
  are used when the queued run starts.
- All queued callers' callbacks are **composed**: every queued caller receives
  state updates from the queued run, even if their `arg` was overwritten.

---

### `exclusiveProcess.getCapabilities() → ExclusiveProcessCapabilities`

Returns the capabilities supplied to the most recently *started* run.  Throws if
called before any run has ever started.  Queued (pending) invocations do not
update the return value of this method until the queued run actually begins.

Procedures retrieve capabilities by calling this method on the outer-scope
instance rather than receiving them as a parameter:

```js
const ep = makeExclusiveProcess({ ... });
// Inside procedure:
const capabilities = ep.getCapabilities();
```

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

### State updates reach all concurrent callers

Because all handles for the same run share the same fan-out list, every state
mutation via `mutateState` is delivered to every registered callback — including
callbacks registered by attachers that joined after the run started.

```javascript
const ep = makeExclusiveProcess({
    initialState: [],
    procedure: async (mutateState) => {
        await mutateState((s) => [...s, "step-1"]);
        await mutateState((s) => [...s, "step-2"]);
        return "done";
    },
    conflictor: () => "attach",
});

const steps1 = [];
const steps2 = [];

const h1 = ep.invoke(capabilities, undefined, (s) => steps1.push(s)); // initiator
const h2 = ep.invoke(capabilities, undefined, (s) => steps2.push(s)); // attacher

await Promise.all([h1.result, h2.result]);

// Both callers received every state update
console.log(steps1); // [["step-1"], ["step-1", "step-2"]]
console.log(steps2); // [["step-1"], ["step-1", "step-2"]]
```

### Errors propagate to all callers

Because all handles (initiator + every attacher) share the same `Promise`
object, a rejection is seen by every awaiter — not just the one that started
the computation.

```javascript
const ep = makeExclusiveProcess({
    initialState: undefined,
    procedure: (_mutateState, _arg) => Promise.reject(new Error("oops")),
    conflictor: () => "attach",
});

const h1 = ep.invoke(capabilities, undefined); // initiator
const h2 = ep.invoke(capabilities, undefined); // attacher

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
    procedure: (_mutateState, _arg) => Promise.reject(new Error("first failure")),
    conflictor: () => "attach",
});
await ep.invoke(capabilities, undefined).result.catch(() => {});
// ep is now idle again
const h = ep.invoke(capabilities, undefined);
console.log(h.isInitiator); // true
```

---

## Usage pattern

### Shared singleton per subsystem

Create one `ExclusiveProcess` instance per long-running operation.  The
instance must be accessible from every call-site that participates in the
exclusion (typically both the route handler *and* the scheduled job).

Pass `capabilities` via `invoke` — the procedure retrieves them from the
instance using `exclusiveProcessInstance.getCapabilities()`:

```javascript
// backend/src/jobs/diary_summary.js
const { makeExclusiveProcess } = require("../exclusive_process");

const diarySummaryExclusiveProcess = makeExclusiveProcess({
    initialState: { status: "idle" },
    procedure: (mutateState) => {
        // Capabilities come from the instance, not from the arg.
        const capabilities = diarySummaryExclusiveProcess.getCapabilities();
        return _runPipelineUnlocked(capabilities);
    },
    // All concurrent calls attach to the same run — no queuing needed.
    conflictor: () => "attach",
});

function runDiarySummaryPipeline(capabilities, subscriber) {
    return diarySummaryExclusiveProcess.invoke(capabilities, undefined, subscriber).result;
}

module.exports = { runDiarySummaryPipeline, diarySummaryExclusiveProcess };
```

### Options queuing (sync use-case)

When different callers may supply incompatible arguments, use `conflictor` to
ensure conflicting calls are never silently dropped.  Capabilities are passed
separately via `invoke` and the conflictor only inspects `arg` (options):

```javascript
// backend/src/sync/index.js
const synchronizeAllExclusiveProcess = makeExclusiveProcess({
    initialState: { status: "idle" },
    procedure: (mutateState, options) => {
        // Capabilities come from the instance, not from options.
        const capabilities = synchronizeAllExclusiveProcess.getCapabilities();
        return _synchronizeAllUnlocked(capabilities, options);
    },
    // conflictor only inspects options (resetToHostname), not capabilities
    conflictor: (initiating, attaching) => {
        const incomingReset = attaching?.resetToHostname;
        if (incomingReset === undefined) return "attach";
        return incomingReset !== initiating?.resetToHostname ? "queue" : "attach";
    },
});

function synchronizeAll(capabilities, options, subscriber) {
    return synchronizeAllExclusiveProcess.invoke(capabilities, options, subscriber).result;
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
