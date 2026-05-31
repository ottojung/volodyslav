const { makeUniqueFunctor } = require("../../unique_functor");
/**
 * Mutex key for serializing *exclusive* incremental-graph operations with
 * respect to each other (for example, database opens or migrations).
 *
 * Acquiring this key alone does *not* exclude pull/observe activity; it only
 * ensures that two exclusive callers do not run concurrently. To fully
 * exclude all graph activity (pulls, observes, and other exclusive work),
 * use {@link withExclusiveMode}, which combines this key with
 * GRAPH_ACTIVITY_KEY in "exclusive" mode.
 *
 * Regular pull/invalidate/inspection paths should use GRAPH_ACTIVITY_KEY
 * mode locking instead (see withObserveMode/withPullMode).
 */
const MUTEX_KEY = makeUniqueFunctor("incremental-graph-operations").instantiate([]);
const GRAPH_ACTIVITY_KEY = makeUniqueFunctor("incremental-graph-activity").instantiate([]);
const COMPUTED_STATE_KEY = makeUniqueFunctor("incremental-graph-computed-state");
const PULL_NODE_KEY = makeUniqueFunctor("incremental-graph-pull-node");

/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */
/** @typedef {import('./graph_state').Transaction} Transaction */

/**
 * Executes a procedure while holding the global incremental-graph mutex
 * (`MUTEX_KEY`), ensuring that only one *exclusive* operation using this
 * helper runs at a time.
 *
 * This helper only serializes callers that explicitly opt into using
 * `MUTEX_KEY`; it does *not* by itself block pull/observe activity. For a
 * higher-level primitive that prevents all concurrent graph activity (pulls,
 * observes, and other exclusive operations), use {@link withExclusiveMode}.
 *
 * @template T
 * @param {SleepCapability} sleeper - The sleeper capability used to acquire the mutex lock.
 * @param {() => Promise<T>} procedure - The asynchronous procedure to execute while holding the lock.
 * @returns {Promise<T>} - A promise that resolves with the result of the procedure when it has completed execution.
 */
function withMutex(sleeper, procedure) {
    return sleeper.withMutex(MUTEX_KEY, procedure);
}

/**
 * @template T
 * @param {SleepCapability} sleeper
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function withObserveMode(sleeper, procedure) {
    return sleeper.withModeMutex(GRAPH_ACTIVITY_KEY, "observe", procedure);
}

/**
 * @template T
 * @param {SleepCapability} sleeper
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function withPullMode(sleeper, procedure) {
    return sleeper.withModeMutex(GRAPH_ACTIVITY_KEY, "pull", procedure);
}

/**
 * Serialize writes to the active replica computed state.
 *
 * This mutex is **non-reentrant**: callers that already hold it must not
 * attempt to re-acquire it. Nested operations (e.g. a pull triggered inside a
 * computor) must share the outer batch and identifier resolver instead of
 * calling withComputedStateMutex recursively; attempting to do so would
 * deadlock.
 *
 * @template T
 * @param {SleepCapability} sleeper
 * @param {string} computedStateIdentifier - Active replica/computed-state identifier.
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function withComputedStateMutex(sleeper, computedStateIdentifier, procedure) {
    return sleeper.withMutex(
        COMPUTED_STATE_KEY.instantiate([computedStateIdentifier]),
        procedure
    );
}


/**
 * Hold the per-node pull lock until the owning transaction releases all held
 * pull-node locks. This lets nested dependency pulls finish their local async
 * work while still preventing another transaction from pulling the same
 * concrete node before the first transaction commits or aborts.
 *
 * @template T
 * @param {SleepCapability} sleeper
 * @param {Transaction} tx
 * @param {string} nodeKey
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
async function withHeldPullNodeLock(sleeper, tx, nodeKey, procedure) {
    if (tx.heldPullNodeLocks.has(nodeKey)) {
        return await procedure();
    }

    /** @type {() => void} */
    let markEntered = () => undefined;
    const entered = new Promise((resolve) => {
        markEntered = () => resolve(undefined);
    });

    const lockPromise = sleeper.withMutex(
        PULL_NODE_KEY.instantiate([nodeKey]),
        async () => {
            tx.heldPullNodeLocks.add(nodeKey);
            markEntered();
            await tx.pullNodeLocksReleased;
        }
    );
    tx.heldPullNodeLockPromises.push(lockPromise);
    await entered;
    return await procedure();
}

/**
 * Acquires an exclusive lock that prevents all concurrent graph activity:
 * pulls, observes, and other exclusive operations (database opens, migrations).
 *
 * Internally this acquires MUTEX_KEY first (to serialize concurrent exclusive
 * callers with each other) and then acquires GRAPH_ACTIVITY_KEY in "exclusive"
 * mode (to block any in-flight pulls or observe-mode operations from running
 * concurrently with the critical section).
 *
 * Acquisition order: MUTEX_KEY → GRAPH_ACTIVITY_KEY("exclusive").
 * Pull and observe operations only ever acquire GRAPH_ACTIVITY_KEY, so the
 * ordering is acyclic and deadlock-free.
 *
 * @template T
 * @param {SleepCapability} sleeper
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function withExclusiveMode(sleeper, procedure) {
    return sleeper.withMutex(MUTEX_KEY, () =>
        sleeper.withModeMutex(GRAPH_ACTIVITY_KEY, "exclusive", procedure)
    );
}

module.exports = {
    withMutex,
    withExclusiveMode,
    withObserveMode,
    withPullMode,
    withComputedStateMutex,
    withHeldPullNodeLock,
};
