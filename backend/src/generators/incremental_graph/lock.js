const { makeUniqueFunctor } = require("../../unique_functor");
const { nodeKeyStringToString } = require("./database");

/**
 * Mutex key for operations that must exclude all incremental-graph activity
 * (for example, migration). Regular pull/invalidate/inspection paths should use
 * GRAPH_ACTIVITY_KEY mode locking instead.
 */
const MUTEX_KEY = makeUniqueFunctor("incremental-graph-operations").instantiate([]);
const GRAPH_ACTIVITY_KEY = makeUniqueFunctor("incremental-graph-activity").instantiate([]);
const PULL_NODE_KEY = makeUniqueFunctor("incremental-graph-pull-node");

/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */

/**
 * Executes a procedure with a mutex lock to ensure that only one operation that requires the lock is running at a time.
 * The lock is identified by a unique key, which in this case is a UniqueTerm instance created from the "incremental-graph-operations" functor.
 * This is used to serialize operations like invalidate() and pull() in the incremental graph generator to prevent
 * concurrent modifications that could lead to inconsistent state.
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
 * @template T
 * @param {SleepCapability} sleeper
 * @param {NodeKeyString} nodeKeyStr
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function withPullNodeMutex(sleeper, nodeKeyStr, procedure) {
    return sleeper.withMutex(
        PULL_NODE_KEY.instantiate([nodeKeyStringToString(nodeKeyStr)]),
        procedure
    );
}

module.exports = {
    withMutex,
    withObserveMode,
    withPullMode,
    withPullNodeMutex,
};
