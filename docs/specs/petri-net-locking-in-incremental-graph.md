# Incremental Graph Petri Locking Design

## Status

Target design.

This document describes the target locking implementation for the incremental graph. The implementation should replace nested ad-hoc lock acquisition with a small Petri-net-inspired resource scheduler.

The goal is not to implement a general Petri net engine. The goal is to implement a small, explicit, testable lock admission controller whose behavior can be described as a colored Petri net:

* resources are places;
* active holders are tokens;
* lock requests are transitions;
* compatibility rules are guards;
* release is the reverse transition.

## Summary

The locking implementation MUST provide these public operations:

```js
const locks = {
    withObserveLock,
    withPullLock,
    withExclusiveLock,
    withPullNodeLock,
    withCommitMutex,
};

module.exports = { locks, withExclusiveMutex, withCommitMutex };
```

The module MUST export the `locks` aggregate object. It also exports `withExclusiveMutex` and `withCommitMutex` as standalone functions for call sites that need them directly (e.g. `graph_api.js` uses `withExclusiveMutex`, `graph_state.js` uses `withCommitMutex`).

The intended call sites are:

```js
await locks.withObserveLock(sleeper, async () => {
    // invalidate() or inspection read
});

await locks.withPullLock(sleeper, nodeKeyString, async () => {
    // pull/recompute this concrete node
});

await locks.withExclusiveLock(sleeper, async () => {
    // migration, database open/reset, or other whole-graph exclusive operation
});

await locks.withPullNodeLock(sleeper, nodeKeyString, async () => {
    // recursive/dynamic pull during an already-active pull operation
});

await locks.withCommitMutex(sleeper, replicaName, async () => {
    // serialize commits for a given replica name
});
```

The lock implementation MUST provide these concurrency semantics:

1. Many observe operations may run concurrently.
2. Many pull operations may run concurrently.
3. Observe operations and pull operations must not overlap.
4. Pulls for the same concrete node must not overlap.
5. Pulls for different concrete nodes may overlap.
6. Exclusive operations must not overlap with observe, pull, or other exclusive operations.
7. Queued conflicting operations must not be starved by later compatible operations.

## Terminology

### Observe operation

An observe operation is graph activity that is allowed to overlap with other observe operations, but not with pull activity.

Examples:

* `invalidate(node)`;
* inspection reads such as `getValue()`;
* inspection reads such as `listMaterializedNodes()`.

Observe operations use the graph activity resource in mode `"observe"`.

### Pull operation

A pull operation recomputes or ensures materialization of one concrete node.

Pull operations use:

* graph activity resource in mode `"pull"`;
* one per-node pull resource for the concrete node being pulled.

The per-node resource serializes same-node pulls while allowing different-node pulls to proceed concurrently.

### Exclusive operation

An exclusive operation requires full graph exclusion.

Examples:

* database open;
* migration;
* reset/import;
* any operation that must see no concurrent graph activity.

Exclusive operations use the graph activity resource in mode `"exclusive"`.

## Public API

### `locks.withObserveLock`

```js
/**
 * Run an observe-mode graph operation.
 *
 * Observe operations are compatible with other observe operations.
 * Observe operations conflict with pull and exclusive operations.
 *
 * @template T
 * @param {SleepCapability} sleeper
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
async function withObserveLock(sleeper, procedure)
```

This function MUST acquire the graph activity resource in mode `"observe"`.

It MUST NOT acquire any per-node pull resource.

It MUST release the resource if `procedure` throws.

### `locks.withPullLock`

```js
/**
 * Run a pull operation for one concrete node.
 *
 * Pull operations are compatible with pulls for other nodes.
 * Pull operations conflict with observe and exclusive operations.
 * Pull operations for the same concrete node conflict with each other.
 *
 * @template T
 * @param {SleepCapability} sleeper
 * @param {NodeKeyString} nodeKeyString
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
async function withPullLock(sleeper, nodeKeyString, procedure)
```

This function MUST acquire both:

```js
[
    { kind: "mode", key: GRAPH_ACTIVITY_KEY, mode: "pull" },
    { kind: "mutex", key: PULL_NODE_KEY(nodeKeyString) },
]
```

The acquisition MUST be atomic from the caller’s perspective: either the request is admitted with all required resources, or it waits while holding none of them.

This is important. The implementation should not enter graph pull mode and then wait for the per-node lock, because that would count as active pull activity even though no node pull is running yet.

### `locks.withExclusiveLock`

```js
/**
 * Run a whole-graph exclusive operation.
 *
 * Exclusive operations conflict with observe, pull, and other exclusive
 * operations.
 *
 * @template T
 * @param {SleepCapability} sleeper
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
async function withExclusiveLock(sleeper, procedure)
```

This function MUST acquire the graph activity resource in mode `"exclusive"`.

It may also acquire a separate exclusive-operation mutex if the implementation needs to serialize extra non-graph state, but the public semantics must be expressible as:

```js
[
    { kind: "mode", key: GRAPH_ACTIVITY_KEY, mode: "exclusive" },
]
```

If a separate exclusive-operation mutex remains necessary, it must be acquired atomically with the graph activity resource through the same scheduler. It must not be acquired through nested manual locking.

## Internal Model

The implementation provides a standalone scheduler module at `backend/src/locknet/class.js`, completely independent of any incremental graph business.

```js
class LockNet {
    async run(resources, procedure) {
        const ticket = this.enqueue(resources);
        await this.waitUntilAdmitted(ticket);
        try {
            return await procedure();
        } finally {
            this.release(ticket);
        }
    }
}
```

The module exports only `makeLockNet()` factory function. The class itself is not exported, following the project's encapsulation convention.

A resource request is a list of resource requirements:

```js
/**
 * @typedef {
 *   | { kind: "mode", key: string, mode: "observe" | "pull" | "exclusive" }
 *   | { kind: "mutex", key: string }
 * } LockResource
 */
```

Keys are plain strings in the standalone LockNet. The callers (e.g. `lock.js`) are responsible for serializing `UniqueTerm` keys via `.serialize()` before passing them to `LockNet.run`.

The scheduler MUST be the only place that knows how to admit lock requests. Call sites should not manually compose lock acquisition with nested calls.

## Petri-Net Interpretation

The scheduler can be understood as a colored Petri net.

Places:

```text
Available(resource)
Held(request, resource)
Queued(request)
Running(request)
```

Transitions:

```text
enqueue(request, resources)
admit(request)
release(request)
```

A request transition is enabled when:

1. all requested resources are compatible with current active holders;
2. admitting the request would not violate FIFO fairness;
3. the request can receive all its resources atomically.

When `admit(request)` fires, the request moves from `Queued` to `Running`, and tokens are added to `Held(request, resource)` for every requested resource.

When `release(request)` fires, all held resource tokens for that request are removed.

This is a conceptual model. The implementation does not need to expose Petri-net terminology publicly.

## Compatibility Rules

### Mode resource

A mode resource has:

```js
{
    kind: "mode",
    key,
    mode,
}
```

Compatibility is per key.

For a given mode key:

| Active mode | Incoming mode | Compatible? |
| ----------- | ------------: | ----------: |
| none        |       observe |         yes |
| none        |          pull |         yes |
| none        |     exclusive |         yes |
| observe     |       observe |         yes |
| observe     |          pull |          no |
| observe     |     exclusive |          no |
| pull        |          pull |         yes |
| pull        |       observe |          no |
| pull        |     exclusive |          no |
| exclusive   |       observe |          no |
| exclusive   |          pull |          no |
| exclusive   |     exclusive |          no |

### Mutex resource

A mutex resource has:

```js
{
    kind: "mutex",
    key,
}
```

Compatibility is per key.

For a given mutex key:

| Active holders | Incoming holder | Compatible? |
| -------------: | --------------: | ----------: |
|              0 |             yes |             |
|      1 or more |              no |             |

The implementation should maintain the invariant that a mutex resource never has more than one active holder.

## Required Safety Invariants

The implementation MUST preserve these invariants after every scheduler transition.

### Graph phase exclusion

If any observe operation is active, then no pull or exclusive operation is active.

```text
active(observe) > 0
⇒ active(pull) = 0 and active(exclusive) = 0
```

If any pull operation is active, then no observe or exclusive operation is active.

```text
active(pull) > 0
⇒ active(observe) = 0 and active(exclusive) = 0
```

If an exclusive operation is active, no other graph operation is active.

```text
active(exclusive) > 0
⇒ active(observe) = 0 and active(pull) = 0 and active(exclusive) = 1
```

### Same-node pull exclusion

For each concrete node:

```text
activePulls(node) ≤ 1
```

### Different-node pull concurrency

The scheduler MUST NOT introduce a global pull mutex. Two pull requests for distinct nodes must be admissible concurrently when there is no conflicting observe or exclusive operation.

### Atomic resource admission

No request may hold a strict subset of its required resources while waiting for the rest.

This invariant prevents lock-order deadlocks.

### Exception-safe release

If the user procedure throws, all resources held by the request MUST be released before the returned promise rejects.

## Required Liveness Properties

The scheduler MUST prevent starvation.

The required policy is FIFO group fairness:

1. Requests are queued in arrival order.
2. If the queue is non-empty, later arrivals must not bypass earlier conflicting requests.
3. When active holders drain, the scheduler admits the maximal compatible prefix/group from the front of the queue.
4. Same-mode graph requests may be admitted as a group.
5. Pull requests may be admitted together only when their per-node mutex resources do not conflict.
6. A later pull must not repeatedly join active pull work while an earlier observe request waits.
7. A later observe must not repeatedly join active observe work while an earlier pull request waits.

This rule permits concurrency while preserving fairness.

Example:

```text
pull(A) starts
observe waits
pull(B) arrives
pull(C) arrives
```

`pull(B)` and `pull(C)` must not bypass the queued `observe`, even though they would be compatible with the currently active `pull(A)`. Once `pull(A)` finishes, the waiting `observe` must get a chance to run.

Another example:

```text
pull(A) waits
pull(B) arrives
pull(C) arrives
```

If there is no conflicting observe/exclusive operation and the node locks differ, the scheduler may admit `pull(A)`, `pull(B)`, and `pull(C)` as one compatible pull batch.

## Queue Admission Algorithm

The implementation should maintain:

```js
const active = new Map(); // resourceKey -> active holder info
const queue = [];         // FIFO tickets
```

Each ticket contains:

```js
{
    id,
    resources,
    resolve,
    reject,
    state, // "queued" | "running" | "released"
}
```

On each enqueue or release, the scheduler runs `drainQueue()`.

`drainQueue()` MUST consider queued requests in FIFO order. It should admit a maximal compatible prefix/group, stopping at the first request that cannot be admitted.

A request can be admitted when:

```js
canAdmit(ticket, active, admittedInThisDrain)
```

returns true.

`canAdmit` must check compatibility against both:

1. already active holders;
2. requests selected earlier in the same drain step.

This allows the scheduler to admit, for example, multiple observe requests together or multiple non-conflicting pull requests together.

But it prevents admitting two same-node pulls in the same drain step.

## Recursive Pulls

Recursive pulls are allowed, but the locking protocol must remain explicit.

If `pull(A)` computes and dynamically pulls `B`, then the implementation must call:

```js
await locks.withPullLock(sleeper, nodeKeyB, async () => {
    // pull B
});
```

The scheduler’s atomic resource admission avoids deadlock caused by partial lock holding.

However, the incremental graph layer must still handle dynamic dependency cycles. If `A` dynamically pulls `A`, or if `A → B → A`, the pull layer must detect or deduplicate the in-flight computation. The lock scheduler is not responsible for proving the graph is acyclic.

The lock scheduler’s responsibility is only:

* never admit two concurrent pulls for the same concrete node;
* never overlap pull activity with observe activity;
* never deadlock due to partial resource acquisition.

## Debugging and Test Hooks

The scheduler SHOULD expose a test-only/debug-only snapshot function:

```js
lockNet.debugSnapshot()
```

The snapshot should include:

```js
{
    activeResources,
    queue,
    runningTickets,
}
```

The production API does not need to expose this function.

Tests should use the debug snapshot to assert invariants after each interesting transition.

## Test Requirements

The implementation MUST include tests for the following cases.

### Observe concurrency

Multiple observe locks may overlap.

Scenario:

```text
observe1 enters
observe2 enters before observe1 exits
```

Expected:

```text
both run concurrently
```

### Pull concurrency for different nodes

Pulls for different nodes may overlap.

Scenario:

```text
pull(A) enters
pull(B) enters before pull(A) exits
```

Expected:

```text
both run concurrently
```

### Same-node pull serialization

Pulls for the same node must serialize.

Scenario:

```text
pull(A) enters
pull(A) attempts to enter
```

Expected:

```text
second pull(A) waits until first pull(A) exits
```

### Pull excludes observe

Pull and observe must not overlap.

Scenario:

```text
pull(A) enters
observe attempts to enter
```

Expected:

```text
observe waits until pull(A) exits
```

And conversely:

```text
observe enters
pull(A) attempts to enter
```

Expected:

```text
pull(A) waits until observe exits
```

### Exclusive excludes everything

Exclusive operations must not overlap with observe, pull, or other exclusive operations.

### FIFO fairness

A waiting conflicting request must not be bypassed by later compatible requests.

Scenario:

```text
pull(A) enters
observe waits
pull(B) arrives
```

Expected:

```text
pull(B) does not enter before observe
```

### Atomic admission

The implementation must not hold graph pull mode while waiting for the node mutex.

A test should observe that a blocked same-node pull does not prevent an earlier queued observe from running once the active pull exits.

### Exception release

If a procedure throws, the scheduler must release all resources.

Scenario:

```text
pull(A) enters
pull(A) throws
pull(A) attempts again
```

Expected:

```text
second pull(A) can enter
```

### Randomized model tests

A randomized test should generate operations:

* observe;
* pull over a small set of node names;
* exclusive;
* failures inside procedures;
* delayed releases.

After every admission and release, the test must check the safety invariants.

## Non-Goals

This design does not attempt to make `getValue(A)` concurrent with `pull(B)` when `A` and `B` are disjoint.

This design does not attempt to make `invalidate(A)` concurrent with `pull(B)` when `A` and `B` are disjoint.

This design does not implement a general Petri net engine.

This design does not solve dynamic dependency correctness. The pull/recompute layer must still record dynamic dependencies and handle dynamic cycles or in-flight deduplication.

## Migration Plan

1. Introduce `LockNet` internally.
2. Implement `locks.withObserveLock`, `locks.withPullLock`, and `locks.withExclusiveLock`.
3. Replace direct uses of `withObserveMode` with `locks.withObserveLock`.
4. Replace nested `withPullMode(... withPullNodeMutex(...))` patterns with `locks.withPullLock`.
5. Replace direct uses of `withExclusiveMode` with `locks.withExclusiveLock`.
6. Stop exporting individual lock functions.
7. Export only:

```js
module.exports = { locks };
```

8. Remove old helper names once all call sites are migrated.

## Target Module Shape

The `lock.js` module has this shape, importing `LockNet` from the standalone module at `backend/src/locknet`:

```js
const { makeUniqueFunctor } = require("../../unique_functor");
const { makeLockNet } = require("../../locknet");

const GRAPH_ACTIVITY_KEY =
    makeUniqueFunctor("incremental-graph-activity").instantiate([]);

const EXCLUSIVE_KEY =
    makeUniqueFunctor("incremental-graph-exclusive").instantiate([]);

const PULL_NODE_FUNCTOR =
    makeUniqueFunctor("incremental-graph-pull-node");

const COMMIT_KEY = makeUniqueFunctor("incremental-graph-commit");

const lockNet = makeLockNet();

function pullNodeKey(nodeKeyString) {
    return PULL_NODE_FUNCTOR.instantiate([nodeKeyString]);
}

async function withObserveLock(sleeper, procedure) {
    return lockNet.run([
        { kind: "mode", key: GRAPH_ACTIVITY_KEY.serialize(), mode: "observe" },
    ], procedure);
}

async function withPullLock(sleeper, nodeKeyString, procedure) {
    return lockNet.run([
        { kind: "mode", key: GRAPH_ACTIVITY_KEY.serialize(), mode: "pull" },
    ], async () => {
        return sleeper.withMutex(pullNodeKey(nodeKeyString), procedure);
    });
}

async function withExclusiveLock(sleeper, procedure) {
    return lockNet.run([
        { kind: "mode", key: GRAPH_ACTIVITY_KEY.serialize(), mode: "exclusive" },
        { kind: "mutex", key: EXCLUSIVE_KEY.serialize() },
    ], procedure);
}

async function withPullNodeLock(sleeper, nodeKeyString, procedure) {
    return sleeper.withMutex(pullNodeKey(nodeKeyString), procedure);
}

async function withExclusiveMutex(sleeper, procedure) {
    return lockNet.run([
        { kind: "mutex", key: EXCLUSIVE_KEY.serialize() },
    ], procedure);
}

async function withCommitMutex(sleeper, replicaName, procedure) {
    return lockNet.run([
        { kind: "mutex", key: COMMIT_KEY.instantiate([replicaName]).serialize() },
    ], procedure);
}

const locks = {
    withObserveLock,
    withPullLock,
    withPullNodeLock,
    withExclusiveLock,
    withCommitMutex,
};

module.exports = { locks, withExclusiveMutex, withCommitMutex };
```

Keys are strings in LockNet resources; `UniqueTerm.serialize()` is called at the call site.

## Acceptance Criteria

The implementation is complete when:

1. `lock.js` exports only the `locks` aggregate object.
2. Observe operations overlap with observe operations.
3. Pull operations overlap with pulls for different nodes.
4. Pull operations serialize with pulls for the same node.
5. Pull and observe operations do not overlap.
6. Exclusive operations do not overlap with any graph activity.
7. No operation holds a partial resource set while waiting for another resource.
8. FIFO fairness prevents starvation across conflicting modes.
9. All resources are released on both success and failure.
10. Randomized scheduler tests preserve all safety invariants.
