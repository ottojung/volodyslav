# ExclusiveProcess

`ExclusiveProcess` is an in-process primitive that ensures a named async
computation runs *at most once at a time* while still being invocable from
many independent call-sites.

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

An `ExclusiveProcess` wraps a single, re-runnable async computation:

```
ExclusiveProcess
  │
  ├─ invoke(procedure) ─ first caller  → starts procedure, returns INITIATOR handle
  │
  └─ invoke(procedure) ─ second caller → ignores procedure, returns ATTACHER handle
                                          both handles share the same result promise
```

After the computation finishes (success *or* error) the `ExclusiveProcess`
resets to idle, so the next `invoke` starts a fresh run.

---

## API

### `makeExclusiveProcess<T>() → ExclusiveProcess<T>`

Creates a new, idle `ExclusiveProcess`.

---

### `exclusiveProcess.invoke(procedure) → ExclusiveProcessHandle<T>`

| State before call | Behaviour |
|---|---|
| Idle | Calls `procedure()`, stores the resulting promise, returns an **initiator** handle |
| Running | Ignores `procedure`, returns an **attacher** handle backed by the same promise |

---

### `handle.isInitiator: boolean`

`true` if this particular call started the computation; `false` if it attached
to an already-running one.

---

### `handle.result: Promise<T>`

A promise shared by the initiator and all attachers.  It resolves with the
return value of `procedure` on success, or rejects with the thrown error on
failure.

---

## Guarantees

### Errors propagate to all callers

Because all handles (initiator + every attacher) share the same `Promise`
object, a rejection is seen by every awaiter — not just the one that started
the computation.

```javascript
const ep = makeExclusiveProcess();

// Initiator
const h1 = ep.invoke(() => Promise.reject(new Error("oops")));
// Attacher
const h2 = ep.invoke(() => Promise.resolve("ignored"));

// Both reject with the same error
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
const ep = makeExclusiveProcess();
await ep.invoke(() => Promise.reject(new Error("first failure"))).result.catch(() => {});
// ep is now idle again
const h = ep.invoke(() => Promise.resolve("second run"));
console.log(h.isInitiator);  // true
```

### Progress is accessible to all callers

Progress state is maintained by the *controller* that wraps the
`ExclusiveProcess` (e.g. `makeSyncController`, `makeDiarySummaryController`).
The controller object is shared between the route handler and the scheduled
job.  Any HTTP client that polls `GET /sync` or `GET /diary-summary/run` sees
the same accumulated state regardless of whether the run was started by the
frontend or by the scheduler.

When a route call *attaches* to an already-running job-initiated computation
the route controller transitions to `status: "running"` and waits for the
shared result promise.  Progress entries emitted before the attachment are not
replayed; entries emitted after the attachment are reflected normally.

---

## Usage pattern

### Shared singleton per subsystem

Create one `ExclusiveProcess` instance per long-running operation.  The
instance must be accessible from every call-site that participates in the
exclusion (typically both the route handler *and* the scheduled job).

```javascript
// backend/src/jobs/diary_summary.js
const { makeExclusiveProcess } = require("../exclusive_process");

const diarySummaryExclusiveProcess = makeExclusiveProcess();

async function runDiarySummaryPipeline(capabilities, callbacks) {
    const handle = diarySummaryExclusiveProcess.invoke(() =>
        _runDiarySummaryPipelineUnlocked(capabilities, callbacks)
    );
    return handle.result;
}

module.exports = { runDiarySummaryPipeline, diarySummaryExclusiveProcess };
```

### Route controller attaching to a running job

```javascript
// backend/src/routes/diary_summary.js
const { diarySummaryExclusiveProcess } = require("../jobs/diary_summary");

function makeDiarySummaryController(capabilities) {
    let currentState = { status: "idle" };

    function start() {
        if (currentState.status === "running") {
            return currentState;
        }

        const started_at = capabilities.datetime.now().toISOString();
        const runningState = { status: "running", started_at, entries: [] };
        currentState = runningState;

        // Attach to (or start) the exclusive process.
        const handle = diarySummaryExclusiveProcess.invoke(() =>
            _runUnlocked(capabilities, { onEntryQueued, onEntryProcessed })
        );

        handle.result
            .then(summary  => { currentState = { status: "success", ... }; })
            .catch(error   => { currentState = { status: "error",   ... }; });

        return currentState;
    }

    return { start, getState: () => currentState };
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
| Total runs (N callers) | N | 1 |
