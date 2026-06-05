/**
 * Think of a cosmic observatory.
 *
 * During the day, people may walk around the dome. They may inspect
 * instruments, update notebooks, and mark old observations as stale.
 *
 * During the night, the dome is dark and observations begin. Many telescopes
 * may work at once, but each telescope may only perform one observation at a
 * time.
 *
 * During a holiday, the observatory is closed. Nobody enters the dome.
 *
 * This is the locking model of the incremental graph.
 */

const { makeUniqueFunctor } = require("../../unique_functor");

/**
 * Daytime activity:
 *   getValue()
 *   getFreshness()
 *   listMaterializedNodes()
 *   invalidate()
 *
 * Nighttime activity:
 *   pull()
 *
 * Holiday activity:
 *   migrate()
 *   cut over replica
 *
 * Telescope use:
 *   one concrete node being pulled
 */

/**
 * Mutex key for serializing *exclusive* incremental-graph operations with
 * respect to each other (for example, database opens or migrations).
 *
 * Acquiring this key alone does *not* exclude pull/daytime activity; it only
 * ensures that two exclusive callers do not run concurrently. To fully exclude
 * all graph activity, use {@link holidayActivity}, which combines this key
 * with GRAPH_ACTIVITY_KEY in "exclusive" mode.
 */
const MUTEX_KEY = makeUniqueFunctor("incremental-graph-operations").instantiate([]);
const GRAPH_ACTIVITY_KEY = makeUniqueFunctor("incremental-graph-activity").instantiate([]);
const COMMIT_KEY = makeUniqueFunctor("incremental-graph-commit");
const PULL_NODE_FUNCTOR = makeUniqueFunctor("incremental-graph-pull-node");


/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */

/**
 * Executes a procedure while holding the global incremental-graph mutex
 * (`MUTEX_KEY`), ensuring that only one *exclusive* operation using this
 * helper runs at a time.
 *
 * This helper only serializes callers that explicitly opt into using
 * `MUTEX_KEY`; it does *not* by itself block pull/observe activity. For a
 * higher-level primitive that prevents all concurrent graph activity (pulls,
 * daytime reads/invalidations, and other exclusive operations), use {@link holidayActivity}.
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
function daytimeActivity(sleeper, procedure) {
    // Mode "observe" is daytime/inspection/invalidate.
    return sleeper.withModeMutex(GRAPH_ACTIVITY_KEY, "observe", procedure);
}

/**
 * @template T
 * @param {SleepCapability} sleeper
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function duringNighttime(sleeper, procedure) {
    // Mode "pull" is nighttime/pull.
    return sleeper.withModeMutex(GRAPH_ACTIVITY_KEY, "pull", procedure);
}

/**
 * Serialize same-node pulls so concurrent calls on the same node do not
 * allocate duplicate identifiers or overwrite each other's results.
 *
 * This mutex is acquired **inside** the nighttime phase and **outside**
 * the transaction commit mutex. The acquisition order is:
 *
 *   GRAPH_ACTIVITY_KEY("pull") → PULL_NODE_FUNCTOR(nodeKeyStr)
 *
 * Recursive pulls acquire PULL_NODE_FUNCTOR for each dependency node;
 * different keys never contend, and a self-deadlock would require a
 * dependency cycle (which the graph constructor rejects).
 *
 * @template T
 * @param {SleepCapability} sleeper
 * @param {NodeKeyString} nodeKeyStr - Serialized node key string identifying the concrete node.
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function telescopeActivity(sleeper, nodeKeyStr, procedure) {
    // Per-node exclusive telescope use.
    // Caller must already be in nighttime mode to satisfy lock ordering.
    return sleeper.withMutex(PULL_NODE_FUNCTOR.instantiate([String(nodeKeyStr)]), procedure);
}

/**
 * @template T
 * @param {SleepCapability} sleeper
 * @param {string} replicaName
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function withCommitMutex(sleeper, replicaName, procedure) {
    return sleeper.withMutex(COMMIT_KEY.instantiate([replicaName]), procedure);
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
function holidayActivity(sleeper, procedure) {
    // Holiday is globally exclusive: it blocks daytime and nighttime.
    // Acquisition order: MUTEX_KEY -> GRAPH_ACTIVITY_KEY("exclusive").
    return sleeper.withMutex(MUTEX_KEY, () =>
        sleeper.withModeMutex(GRAPH_ACTIVITY_KEY, "exclusive", procedure)
    );
}

/**
 * Full observation activity: enter nighttime phase, then acquire the per-node
 * telescope mutex.
 * @template T
 * @param {SleepCapability} sleeper
 * @param {NodeKeyString} nodeKeyString
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function observationActivity(sleeper, nodeKeyString, procedure) {
    return duringNighttime(sleeper, () =>
        telescopeActivity(sleeper, nodeKeyString, procedure)
    );
}

module.exports = {
    withMutex,
    holidayActivity,
    daytimeActivity,
    observationActivity,
    telescopeActivity,
    withCommitMutex,
};
