const { makeUniqueFunctor } = require("../../unique_functor");

/**
 * Mutex key for serializing all invalidate() and pull() operations.
 */
const MUTEX_KEY = makeUniqueFunctor("incremental-graph-operations").instantiate([]);

/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */

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
 * Temporarily releases the incremental-graph mutex, runs a procedure without
 * the lock, then re-acquires the mutex before returning.
 *
 * This MUST be called from within a `withMutex` callback (i.e., while the
 * incremental-graph mutex is currently held).  It is only safe to use for
 * the computor function inside `recompute.js` — the computor receives
 * already-fetched input values and does not interact with the in-memory graph.
 *
 * @template T
 * @param {SleepCapability} sleeper - The sleeper capability.
 * @param {() => Promise<T>} procedure - The procedure to run without the mutex.
 * @returns {Promise<T>}
 */
function withoutMutex(sleeper, procedure) {
    return sleeper.withoutMutex(MUTEX_KEY, procedure);
}

module.exports = {
    withMutex,
    withoutMutex,
};
