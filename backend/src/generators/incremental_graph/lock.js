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
 * Telescope activity:
 *   one concrete node's telescope
 *
 * Darkroom activity:
 *   one replica's finished transaction being developed into the settled record
 *
 * Holiday activity:
 *   migrate()
 *   cut over replica
 */

/**
 * Small holiday gate:
 * it serializes *holiday callers with each other*.
 */
const HOLIDAY_GATE_KEY = makeUniqueFunctor("incremental-graph-holiday-gate").instantiate([]);

/**
 * Dome activity key:
 * it gates whether the dome is in daytime (inspection), nighttime (evaluation),
 * or holiday (closed for maintenance) mode.
 */
const DOME_ACTIVITY_KEY = makeUniqueFunctor("incremental-graph-dome-activity").instantiate([]);

const DOME_CONDITION_DAYTIME = "daytime";
const DOME_CONDITION_NIGHTTIME = "nighttime";
const DOME_CONDITION_HOLIDAY = "holiday";

/**
 * Darkroom functor: per-replica serialization of the short finalization step
 * where finished work becomes part of that replica's settled record.
 */
const DARKROOM_FUNCTOR = makeUniqueFunctor("incremental-graph-darkroom");

/**
 * Telescope functor: per-node serialization of concurrent pulls so a node
 * cannot allocate duplicate identifiers or overwrite each other's results.
 */
const TELESCOPE_FUNCTOR = makeUniqueFunctor("incremental-graph-telescope");


/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */

/**
 * @template T
 * @param {SleepCapability} sleeper
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function daytimeActivity(sleeper, procedure) {
    return sleeper.withModeMutex(
        DOME_ACTIVITY_KEY,
        DOME_CONDITION_DAYTIME,
        procedure
    );
}

/**
 * @template T
 * @param {SleepCapability} sleeper
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function nighttimeActivity(sleeper, procedure) {
    return sleeper.withModeMutex(
        DOME_ACTIVITY_KEY,
        DOME_CONDITION_NIGHTTIME,
        procedure
    );
}

/**
 * Telescope activity:
 *   exclusive use of one concrete node's telescope.
 *
 * Nighttime admits many observations, but each telescope belongs to one node
 * and may only perform one observation at a time. Pulls of different nodes
 * use different telescopes and do not contend here.
 *
 * Acquisition order:
 *   dome nighttime → telescope(node) → darkroom(replica), if a commit follows.
 *
 * Recursive pulls acquire telescopes for each dependency node; different keys
 * never contend, and a self-deadlock would require a dependency cycle (which
 * the graph constructor rejects).
 *
 * @template T
 * @param {SleepCapability} sleeper
 * @param {NodeKeyString} nodeKeyStr - Serialized node key string identifying the concrete node.
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function telescopeActivity(sleeper, nodeKeyStr, procedure) {
    return sleeper.withMutex(
        TELESCOPE_FUNCTOR.instantiate([String(nodeKeyStr)]),
        procedure
    );
}

/**
 * Darkroom activity:
 *   the short per-replica finalization step where finished graph work becomes
 *   part of the settled replica record.
 *
 * Many telescopes may finish observations, but finished plates from the same
 * observatory copy pass through one darkroom. The darkroom does not decide
 * whether the dome is in daytime, nighttime, or holiday mode. It only ensures
 * that one replica develops one transaction into the settled record at a time.
 *
 * Commit-snapshot reads also use the darkroom, so they see the replica between
 * finalization steps rather than midway through one.
 *
 * @template T
 * @param {SleepCapability} sleeper
 * @param {string} replicaName
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function darkroomActivity(sleeper, replicaName, procedure) {
    return sleeper.withMutex(DARKROOM_FUNCTOR.instantiate([replicaName]), procedure);
}

/**
 * Holiday activity:
 *   close the dome for maintenance.
 *
 * Holiday activity waits for daytime and nighttime activity to leave the dome,
 * then prevents new daytime or nighttime activity until the holiday work is
 * done. A small holiday gate is acquired first so two holiday callers do not
 * try to close the dome at the same time.
 *
 * Acquisition order:
 *   holiday gate → dome holiday condition
 *
 * @template T
 * @param {SleepCapability} sleeper
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function holidayActivity(sleeper, procedure) {
    return sleeper.withMutex(HOLIDAY_GATE_KEY, () =>
        sleeper.withModeMutex(
            DOME_ACTIVITY_KEY,
            DOME_CONDITION_HOLIDAY,
            procedure
        )
    );
}

module.exports = {
    holidayActivity,
    daytimeActivity,
    nighttimeActivity,
    telescopeActivity,
    darkroomActivity,
};
