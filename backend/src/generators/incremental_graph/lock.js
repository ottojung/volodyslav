const { makeUniqueFunctor } = require("../../unique_functor");

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
 * @property {import('../../unique_functor').UniqueTerm} key
 * @property {"observe" | "pull" | "exclusive"} mode
 */

/**
 * @typedef {object} LockResourceMutex
 * @property {"mutex"} kind
 * @property {import('../../unique_functor').UniqueTerm} key
 */

/** @typedef {LockResourceMode | LockResourceMutex} LockResource */

/**
 * @typedef {object} LockTicket
 * @property {number} id
 * @property {Array<LockResource>} resources
 * @property {"queued" | "running" | "released"} state
 * @property {Promise<void>} promise
 * @property {(value?: void) => void} resolve
 * @property {(reason?: unknown) => void} reject
 */

class LockNet {
    constructor() {
        this._nextId = 0;
        this._active = new Map();
        this._queue = [];
        this._running = new Map();
    }

    /**
     * @param {Array<LockResource>} resources
     * @param {() => Promise<T>} procedure
     * @returns {Promise<T>}
     * @template T
     */
    async run(resources, procedure) {
        const ticket = this._enqueue(resources);
        await this._waitUntilAdmitted(ticket);
        try {
            return await procedure();
        } finally {
            this._release(ticket);
        }
    }

    /**
     * @param {Array<LockResource>} resources
     * @returns {LockTicket}
     */
    _enqueue(resources) {
        const id = this._nextId++;
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        const ticket = {
            id,
            resources,
            state: "queued",
            promise,
            resolve,
            reject,
        };
        this._queue.push(ticket);
        this._drainQueue();
        return ticket;
    }

    /**
     * @param {LockTicket} ticket
     * @returns {Promise<void>}
     */
    async _waitUntilAdmitted(ticket) {
        if (ticket.state === "running") return;
        await ticket.promise;
    }

    /**
     * @param {LockTicket} ticket
     */
    _release(ticket) {
        if (ticket.state !== "running") return;
        ticket.state = "released";
        for (const resource of ticket.resources) {
            const key = this._resourceKey(resource);
            const entry = this._active.get(key);
            if (!entry) continue;
            if (resource.kind === "mode") {
                entry.count--;
                if (entry.count <= 0) {
                    this._active.delete(key);
                }
            } else {
                this._active.delete(key);
            }
        }
        this._running.delete(ticket.id);
        this._drainQueue();
    }

    _drainQueue() {
        if (this._queue.length === 0) return;
        const admittedInThisDrain = new Map();
        const remaining = [];
        let blocked = false;
        for (const ticket of this._queue) {
            if (!blocked && this._canAdmit(ticket, this._active, admittedInThisDrain)) {
                ticket.state = "running";
                this._activateResources(ticket, this._active);
                this._activateResources(ticket, admittedInThisDrain);
                this._running.set(ticket.id, ticket);
                ticket.resolve(undefined);
            } else {
                blocked = true;
                remaining.push(ticket);
            }
        }
        this._queue = remaining;
    }

    /**
     * @param {LockTicket} ticket
     * @param {Map<string, unknown>} active
     * @param {Map<string, unknown>} admitted
     * @returns {boolean}
     */
    _canAdmit(ticket, active, admitted) {
        for (const resource of ticket.resources) {
            const key = this._resourceKey(resource);
            const activeEntry = active.get(key);
            if (activeEntry && !this._isCompatible(resource, activeEntry)) {
                return false;
            }
            const admittedEntry = admitted.get(key);
            if (admittedEntry && !this._isCompatible(resource, admittedEntry)) {
                return false;
            }
        }
        return true;
    }

    /**
     * @param {LockResource} resource
     * @param {unknown} entry
     * @returns {boolean}
     */
    _isCompatible(resource, entry) {
        if (resource.kind === "mutex") {
            return false;
        }
        if (resource.kind === "mode") {
            if (entry && typeof entry === "object" && "kind" in entry && entry.kind === "mode") {
                return entry.mode === resource.mode;
            }
            return false;
        }
        return false;
    }

    /**
     * @param {LockTicket} ticket
     * @param {Map<string, unknown>} map
     */
    _activateResources(ticket, map) {
        for (const resource of ticket.resources) {
            const key = this._resourceKey(resource);
            if (resource.kind === "mode") {
                let entry = map.get(key);
                if (!entry) {
                    entry = { kind: "mode", mode: resource.mode, count: 0 };
                    map.set(key, entry);
                }
                if (entry.kind === "mode") {
                    entry.count++;
                }
            } else {
                map.set(key, { kind: "mutex", holderId: ticket.id });
            }
        }
    }

    /**
     * @param {LockResource} resource
     * @returns {string}
     */
    _resourceKey(resource) {
        return resource.kind + "::" + resource.key.serialize();
    }

    debugSnapshot() {
        return {
            activeResources: new Map(this._active),
            queue: this._queue.map(t => ({
                id: t.id,
                resources: t.resources,
                state: t.state,
            })),
            runningTickets: this._running.size,
        };
    }
}

const lockNet = new LockNet();

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
        { kind: "mode", key: GRAPH_ACTIVITY_KEY, mode: "observe" },
    ], procedure);
}

/**
 * Top-level pull: atomically acquires pull mode (via LockNet) and per-node
 * mutex (via sleeper). The per-node mutex is acquired inside the LockNet
 * callback so that the caller never holds pull mode without a specific node.
 *
 * Recursive/dynamic pulls during an active pull should use
 * {@link withPullNodeLock} instead, which only acquires the per-node mutex.
 *
 * @template T
 * @param {SleepCapability} sleeper
 * @param {string} nodeKeyString
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
async function withPullLock(sleeper, nodeKeyString, procedure) {
    return lockNet.run([
        { kind: "mode", key: GRAPH_ACTIVITY_KEY, mode: "pull" },
    ], async () => {
        return sleeper.withMutex(pullNodeKey(nodeKeyString), procedure);
    });
}

/**
 * @template T
 * @param {SleepCapability} _sleeper
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
async function withExclusiveLock(_sleeper, procedure) {
    return lockNet.run([
        { kind: "mode", key: GRAPH_ACTIVITY_KEY, mode: "exclusive" },
        { kind: "mutex", key: EXCLUSIVE_KEY },
    ], procedure);
}

/**
 * Acquire only the per-node pull mutex (without acquiring pull mode).
 * Used for recursive/dynamic pulls during an already-active pull operation.
 *
 * @template T
 * @param {SleepCapability} sleeper
 * @param {string} nodeKeyString
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
async function withPullNodeLock(sleeper, nodeKeyString, procedure) {
    return sleeper.withMutex(pullNodeKey(nodeKeyString), procedure);
}

const locks = {
    withObserveLock,
    withPullLock,
    withPullNodeLock,
    withExclusiveLock,
};

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
        { kind: "mutex", key: EXCLUSIVE_KEY },
    ], procedure);
}

/**
 * Serialize commits for a given replica name.
 * This is a low-level mutex separate from graph activity locking.
 *
 * @template T
 * @param {SleepCapability} sleeper
 * @param {string} replicaName
 * @param {() => Promise<T>} procedure
 * @returns {Promise<T>}
 */
function withCommitMutex(sleeper, replicaName, procedure) {
    return sleeper.withMutex(COMMIT_KEY.instantiate([replicaName]), procedure);
}

module.exports = {
    locks,
    withExclusiveMutex,
    withCommitMutex,
};
