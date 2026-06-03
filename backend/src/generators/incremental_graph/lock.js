const { makeUniqueFunctor } = require("../../unique_functor");
const { makeLockNet } = require("../../locknet");

const GRAPH_ACTIVITY_KEY =
    makeUniqueFunctor("incremental-graph-activity").instantiate([]);

const EXCLUSIVE_KEY =
    makeUniqueFunctor("incremental-graph-exclusive").instantiate([]);

const PULL_NODE_FUNCTOR =
    makeUniqueFunctor("incremental-graph-pull-node");

const COMMIT_KEY = makeUniqueFunctor("incremental-graph-commit");

/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */

/**
 * @typedef {object} LockResourceMode
 * @property {"mode"} kind
 * @property {string} key
 * @property {"observe" | "pull" | "exclusive"} mode
 */

/**
 * @typedef {object} LockResourceMutex
 * @property {"mutex"} kind
 * @property {string} key
 */

/** @typedef {LockResourceMode | LockResourceMutex} LockResource */

const lockNet = makeLockNet();
const commitLockNet = makeLockNet();

/**
 * @param {string} nodeKeyString
 * @returns {import('../../unique_functor').UniqueTerm}
 */
function pullNodeKey(nodeKeyString) {
    return PULL_NODE_FUNCTOR.instantiate([nodeKeyString]);
}

/**
 * @template T
 * @param {SleepCapability} _sleeper
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
async function withObserveLock(_sleeper, procedure) {
    return lockNet.run([
        { kind: "mode", key: GRAPH_ACTIVITY_KEY.serialize(), mode: "observe" },
    ], procedure);
}

/**
 * Top-level pull: atomically acquires pull mode and the per-node mutex.
 *
 * Recursive/dynamic pulls during an active pull should use
 * {@link withPullNodeLock} instead, which only acquires the per-node mutex.
 *
 * @template T
 * @param {SleepCapability} _sleeper
 * @param {string} nodeKeyString
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
async function withPullLock(_sleeper, nodeKeyString, procedure) {
    return lockNet.run([
        { kind: "mode", key: GRAPH_ACTIVITY_KEY.serialize(), mode: "pull" },
        { kind: "mutex", key: pullNodeKey(nodeKeyString).serialize() },
    ], procedure);
}

/**
 * @template T
 * @param {SleepCapability} _sleeper
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
async function withExclusiveLock(_sleeper, procedure) {
    return lockNet.run([
        { kind: "mode", key: GRAPH_ACTIVITY_KEY.serialize(), mode: "exclusive" },
        { kind: "mutex", key: EXCLUSIVE_KEY.serialize() },
    ], procedure);
}

/**
 * Acquire only the per-node pull mutex (without acquiring pull mode).
 * Used for recursive/dynamic pulls during an already-active pull operation.
 * Since this is called from within a LockNet-guarded callback, it uses
 * LockNet's re-entrant path to bypass the FIFO queue.
 *
 * @template T
 * @param {SleepCapability} _sleeper
 * @param {string} nodeKeyString
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
async function withPullNodeLock(_sleeper, nodeKeyString, procedure) {
    return lockNet.run([
        { kind: "mutex", key: pullNodeKey(nodeKeyString).serialize() },
    ], procedure);
}

/**
 * Acquire only the EXCLUSIVE_KEY mutex (without exclusive graph mode).
 * Serializes against withExclusiveLock but does not block graph activity.
 * Used by graph_api.js to protect critical sections from synchronizeDatabase.
 *
 * @template T
 * @param {SleepCapability} _sleeper
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
async function withExclusiveMutex(_sleeper, procedure) {
    return lockNet.run([
        { kind: "mutex", key: EXCLUSIVE_KEY.serialize() },
    ], procedure);
}

/**
 * Serialize commits for a given replica name.
 * This is a low-level mutex separate from graph activity locking.
 * Uses its own LockNet instance so it never interferes with graph
 * activity resource scheduling.
 *
 * @template T
 * @param {SleepCapability} _sleeper
 * @param {string} replicaName
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function withCommitMutex(_sleeper, replicaName, procedure) {
    return commitLockNet.run([
        { kind: "mutex", key: COMMIT_KEY.instantiate([replicaName]).serialize() },
    ], procedure);
}

const locks = {
    withObserveLock,
    withPullLock,
    withPullNodeLock,
    withExclusiveLock,
    withExclusiveMutex,
    withCommitMutex,
};

module.exports = {
    locks,
    withExclusiveMutex,
    withCommitMutex,
};
