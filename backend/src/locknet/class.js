const { AsyncLocalStorage } = require("async_hooks");

/**
 * LockNet — a fair resource scheduler for concurrent lock acquisitions.
 *
 * LockNet coordinates access to named resources where each resource is either:
 *
 * - **mode**: supports multiple concurrent holders sharing the same mode value;
 *   different modes for the same key are mutually exclusive.
 * - **mutex**: supports at most one holder at a time.
 *
 * All resources are identified by string keys.  The scheduler enforces FIFO
 * group fairness: once a request is queued, later requests that conflict with
 * it cannot bypass it, even if they are compatible with currently active
 * holders.
 *
 * **Re-entrancy**: calls to {@link LockNet#run run()} made from within a
 * running LockNet callback are detected via per-instance
 * `AsyncLocalStorage` and bypass the FIFO queue.  They are admitted
 * immediately when their resources are compatible with currently active
 * resources.  This prevents circular-wait deadlocks that would otherwise
 * occur when a LockNet-guarded operation internally needs to acquire
 * additional resources through the same scheduler (e.g. a pull acquiring a
 * per-node mutex, or an invalidate acquiring a commit-series mutex).
 *
 * The scheduler is independent of any particular domain and can be reused
 * across subsystems.
 *
 * @module locknet
 */

/**
 * @typedef {"mode" | "mutex"} LockResourceKind
 */

/**
 * A mode resource.  Modes with the same key and same mode value can run
 * concurrently; different modes for the same key block each other.
 *
 * @typedef {object} LockResourceMode
 * @property {"mode"} kind
 * @property {string} key - Opaque resource identifier.
 * @property {string} mode - Mode value (e.g. "observe", "pull", "exclusive").
 */

/**
 * A mutex resource.  At most one holder may hold a mutex for a given key.
 *
 * @typedef {object} LockResourceMutex
 * @property {"mutex"} kind
 * @property {string} key - Opaque resource identifier.
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

/**
 * @typedef {object} ModeEntry
 * @property {"mode"} kind
 * @property {string} mode
 * @property {number} count
 */

/**
 * @typedef {object} MutexEntry
 * @property {"mutex"} kind
 * @property {number} holderId
 */

/** @typedef {ModeEntry | MutexEntry} ActiveEntry */

/**
 * @typedef {"queued" | "running" | "released"} TicketState
 */

class LockNet {
    constructor() {
        this._nextId = 0;
        /** @type {Map<string, ActiveEntry>} */
        this._active = new Map();
        /** @type {Array<LockTicket>} */
        this._queue = [];
        /** @type {Map<number, LockTicket>} */
        this._running = new Map();
        /**
         * Per-instance async-local storage for re-entrancy detection.
         * Set to the current ticket while a callback is executing.
         * @type {AsyncLocalStorage<LockTicket>}
         */
        this._als = new AsyncLocalStorage();
    }

    /**
     * Acquire the given resources, run `procedure`, then release.
     *
     * Returns a promise that resolves with the return value of `procedure`.
     * If `procedure` throws, all resources are released before the returned
     * promise rejects.
     *
     * Supports re-entrant calls: when invoked from within a running LockNet
     * callback, the call bypasses the FIFO queue and is admitted immediately
     * if its resources are compatible with currently active resources.
     *
     * @template T
     * @param {Array<LockResource>} resources - Resources to acquire.
     * @param {() => Promise<T>} procedure - Critical section to run.
     * @returns {Promise<T>}
     */
    async run(resources, procedure) {
        const ticket = this._enqueue(resources);
        await this._waitUntilAdmitted(ticket);
        return this._als.run(ticket, async () => {
            try {
                return await procedure();
            } finally {
                this._release(ticket);
            }
        });
    }

    /**
     * Create a ticket and attempt admission.
     *
     * Re-entrant calls (made from within a running LockNet callback) bypass
     * the FIFO queue and are admitted immediately when their resources are
     * compatible with currently active resources.  This prevents the
     * circular-wait deadlock where a nested call would block behind a FIFO
     * waiter that itself waits for the outer ticket to finish.
     *
     * @param {Array<LockResource>} resources
     * @returns {LockTicket}
     */
    _enqueue(resources) {
        const id = this._nextId++;
        const QUEUED = "queued";
        /** @type {LockTicket['resolve']} */
        let resolve = function() {};
        /** @type {LockTicket['reject']} */
        let reject = function() {};
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        /** @type {LockTicket} */
        const ticket = {
            id,
            resources,
            state: QUEUED,
            promise,
            resolve,
            reject,
        };

        const currentTicket = this._als.getStore();
        if (currentTicket !== undefined) {
            if (this._canAdmit(ticket, this._active, new Map())) {
                ticket.state = "running";
                this._activateResources(ticket, this._active);
                this._running.set(ticket.id, ticket);
                ticket.resolve(undefined);
                return ticket;
            }
            // Re-entrant but not immediately compatible: insert at the front of
            // the FIFO queue so unrelated waiters cannot block this nested call.
            // The holder of the conflicting resource will drain the queue when
            // it releases, at which point this ticket can be admitted.
            this._queue.unshift(ticket);
            return ticket;
        }

        this._queue.push(ticket);
        this._drainQueue();
        return ticket;
    }

    /**
     * Wait until the ticket is admitted (state changes to "running").
     * @param {LockTicket} ticket
     * @returns {Promise<void>}
     */
    async _waitUntilAdmitted(ticket) {
        if (ticket.state === "running") return;
        await ticket.promise;
    }

    /**
     * Release all resources held by `ticket` and re-attempt queue drain.
     * @param {LockTicket} ticket
     */
    _release(ticket) {
        if (ticket.state !== "running") return;
        ticket.state = "released";
        for (const resource of ticket.resources) {
            const key = this._resourceKey(resource);
            const entry = this._active.get(key);
            if (!entry) continue;
            if (resource.kind === "mode" && entry.kind === "mode") {
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

    /**
     * Scan the queue and admit any ticket whose resources are compatible with
     * currently active resources.  A queued ticket that is compatible with
     * currently active resources is still NOT admitted if it shares a
     * conflicting resource with an earlier-queued ticket that remains
     * unadmitted — this preserves FIFO ordering among tickets that compete
     * for the same resource.
     *
     * Because resources are identified by (kind, key) pairs and the scheduler
     * manages many independent resources, a ticket for an unrelated resource
     * must not be blocked by a ticket for a different resource that happens
     * to sit ahead of it in the queue.  Admitting tickets out of order when
     * they do not conflict with earlier waiters achieves the same effect as
     * having per-resource queues while keeping a single global ordering for
     * tickets that genuinely conflict.
     */
    _drainQueue() {
        if (this._queue.length === 0) return;
        /** @type {Map<string, ActiveEntry>} */
        const admittedInThisDrain = new Map();
        /** @type {Array<LockTicket>} */
        const remaining = [];
        for (const ticket of this._queue) {
            if (ticket.state === "running") continue;
            if (
                this._canAdmit(ticket, this._active, admittedInThisDrain)
                && !this._conflictsWithAny(ticket, remaining)
            ) {
                ticket.state = "running";
                this._activateResources(ticket, this._active);
                this._activateResources(ticket, admittedInThisDrain);
                this._running.set(ticket.id, ticket);
                ticket.resolve(undefined);
            } else {
                remaining.push(ticket);
            }
        }
        this._queue = remaining;
    }

    /**
     * Check whether `ticket` can be admitted given the already-active
     * resources and the resources already tentatively admitted in the
     * current drain step.
     *
     * @param {LockTicket} ticket
     * @param {Map<string, ActiveEntry>} active
     * @param {Map<string, ActiveEntry>} admitted
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
     * Returns whether `resource` is compatible with the currently-active
     * holder described by `entry`.
     *
     * @param {LockResource} resource
     * @param {ActiveEntry} entry
     * @returns {boolean}
     */
    _isCompatible(resource, entry) {
        if (resource.kind === "mutex") {
            return false;
        }
        if (resource.kind === "mode") {
            if (entry.kind === "mode") {
                return entry.mode === resource.mode;
            }
            return false;
        }
        return false;
    }

    /**
     * Record that `ticket` holds its resources in the given `map`.
     * @param {LockTicket} ticket
     * @param {Map<string, ActiveEntry>} map
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
     * Check whether `ticket` shares a conflicting resource with any ticket
     * in `ahead` (unadmitted tickets that sit ahead of `ticket` in the
     * queue).  When two tickets compete for the same resource, the earlier
     * one must be admitted first; this method prevents starvation of earlier
     * waiters by later ones that happen to be compatible with currently
     * active resources.
     *
     * @param {LockTicket} ticket
     * @param {Array<LockTicket>} ahead
     * @returns {boolean}
     */
    _conflictsWithAny(ticket, ahead) {
        for (const other of ahead) {
            if (this._ticketsConflict(ticket, other)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Two tickets conflict if they share at least one resource key and the
     * resources for that key are incompatible (different mode values, or
     * one is a mutex).
     *
     * @param {LockTicket} a
     * @param {LockTicket} b
     * @returns {boolean}
     */
    _ticketsConflict(a, b) {
        for (const rA of a.resources) {
            for (const rB of b.resources) {
                if (this._resourceKey(rA) !== this._resourceKey(rB)) continue;
                if (rA.kind === "mutex" || rB.kind === "mutex") return true;
                if (rA.kind === "mode" && rB.kind === "mode" && rA.mode !== rB.mode) return true;
            }
        }
        return false;
    }

    /**
     * Produce a stable string key for a resource, used as a Map key.
     * @param {LockResource} resource
     * @returns {string}
     */
    _resourceKey(resource) {
        return resource.kind + "::" + resource.key;
    }

    /**
     * Return a snapshot of the scheduler state for debugging and testing.
     * The returned object is a plain data structure.
     *
     * @returns {{ activeResources: Array<{ key: string, entry: ActiveEntry }>, queue: Array<{ id: number, resources: Array<LockResource>, state: string }>, runningTickets: number }}
     */
    debugSnapshot() {
        return {
            activeResources: Array.from(this._active.entries()).map(([key, entry]) => ({
                key,
                entry: { ...entry },
            })),
            queue: this._queue.map(t => ({
                id: t.id,
                resources: t.resources,
                state: t.state,
            })),
            runningTickets: this._running.size,
        };
    }
}

/**
 * Create a new LockNet instance.
 *
 * @returns {LockNet}
 */
function makeLockNet() {
    return new LockNet();
}

module.exports = { makeLockNet };
