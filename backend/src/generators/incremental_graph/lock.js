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
// Darkroom lock: serializes per-replica finalization where finished work
// becomes part of the settled replica record.
const DARKROOM_KEY = makeUniqueFunctor("incremental-graph-darkroom");
const PULL_NODE_FUNCTOR = makeUniqueFunctor("incremental-graph-pull-node");


/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */

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
function nighttimeActivity(sleeper, procedure) {
    // Mode "pull" is nighttime/pull.
    return sleeper.withModeMutex(GRAPH_ACTIVITY_KEY, "pull", procedure);
}

/**
 * Serialize same-node pulls so concurrent calls on the same node do not
 * allocate duplicate identifiers or overwrite each other's results.
 *
 * This mutex is acquired **inside** the nighttime phase and **outside**
 * the per-replica darkroom lock. The acquisition order is:
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
 * Darkroom activity:
 *   the short per-replica finalization step where finished graph work becomes
 *   part of the settled replica record.
 *
 * Observations may happen at many telescopes, but finished plates from the
 * same observatory copy pass through one darkroom. The darkroom does not
 * control whether the dome is in daytime, nighttime, or holiday mode; it only
 * ensures that one replica's commit/publication step happens one transaction
 * at a time.
 *
 * This lock is also used for commit-snapshot reads, so readers do not inspect
 * a replica while a transaction is being developed into the settled record.
 *
 * @template T
 * @param {SleepCapability} sleeper
 * @param {string} replicaName
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function darkroomActivity(sleeper, replicaName, procedure) {
    return sleeper.withMutex(DARKROOM_KEY.instantiate([replicaName]), procedure);
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

module.exports = {
    holidayActivity,
    daytimeActivity,
    nighttimeActivity,
    telescopeActivity,
    darkroomActivity,
};
