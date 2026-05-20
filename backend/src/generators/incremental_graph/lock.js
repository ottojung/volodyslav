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
const PULL_NODE_KEY = makeUniqueFunctor("incremental-graph-pull-node");
const IDENTIFIER_LOOKUP_KEY = makeUniqueFunctor("incremental-graph-identifier-lookup").instantiate([]);

/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */

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
 * @template T
 * @param {SleepCapability} sleeper
 * @param {NodeIdentifier | NodeKeyString} nodeKeyStr
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function withPullNodeMutex(sleeper, nodeKeyStr, procedure) {
    return sleeper.withMutex(
        PULL_NODE_KEY.instantiate([String(nodeKeyStr)]),
        procedure
    );
}

/**
 * Serialize identifier lookup persistence so concurrent pulls for different
 * semantic node keys cannot overwrite each other's identifier allocations.
 *
 * @template T
 * @param {SleepCapability} sleeper
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function withIdentifierLookupMutex(sleeper, procedure) {
    return sleeper.withMutex(IDENTIFIER_LOOKUP_KEY, procedure);
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
    withPullNodeMutex,
    withIdentifierLookupMutex,
};
