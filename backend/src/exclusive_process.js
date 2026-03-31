/**
 * ExclusiveProcess — an abstraction that ensures only one instance of an async
 * computation runs at a time.
 *
 * Each ExclusiveProcess is created with a **fixed procedure** and optional hooks.
 * When `invoke(args)` is called while no computation is active, the procedure is
 * called with the supplied args and the caller receives a handle marked as the
 * *initiator*.
 *
 * When `invoke(args)` is called while a computation is already running the
 * behaviour depends on the optional hooks:
 *
 * - If `shouldQueue(currentArgs, newArgs)` is provided and returns `true`, the
 *   new call is **queued**: after the current run ends, a fresh run is started
 *   with the queued args and the queued caller's promise resolves/rejects with
 *   that run's outcome.  Last-write-wins when multiple calls are queued during
 *   the same run.
 *
 * - Otherwise the caller **attaches** to the running computation and
 *   `onAttach(newArgs, currentArgs)` is called so that state (e.g. callback
 *   fan-out lists) can be updated.  Both the initiator and all attachers share
 *   the same result promise.
 *
 * After the computation finishes (successfully or with an error) the
 * ExclusiveProcess resets to its idle state so that a subsequent `invoke`
 * starts a new computation.
 *
 * @module exclusive_process
 */

/**
 * @typedef {object} ExclusiveProcessHooks
 * @property {((newArgs: unknown[], currentArgs: unknown[]) => void) | null} [onAttach]
 *   Called when a new invocation attaches to an already-running computation.
 * @property {((currentArgs: unknown[], newArgs: unknown[]) => boolean) | null} [shouldQueue]
 *   If provided and returns `true` for a given pair of current/new args, the
 *   new invocation is queued rather than attached.
 */

/**
 * A handle returned by `invoke`.
 *
 * @template T
 */
class ExclusiveProcessHandleClass {
    /** @type {undefined} */
    __brand = undefined;

    /**
     * @param {boolean} isInitiator - `true` if this caller started the computation.
     * @param {Promise<T>} result   - Resolves/rejects when the computation ends.
     */
    constructor(isInitiator, result) {
        if (this.__brand !== undefined) {
            throw new Error("ExclusiveProcessHandle is a nominal type");
        }
        /** @type {boolean} */
        this.isInitiator = isInitiator;
        /** @type {Promise<T>} */
        this.result = result;
    }
}

/**
 * Ensures only one instance of an async computation runs at a time.
 * The procedure to run is fixed at construction time; callers supply only
 * the arguments via `invoke(args)`.
 *
 * @template T
 */
class ExclusiveProcessClass {
    /** @type {undefined} */
    __brand = undefined;

    /**
     * @param {Function} procedure
     * @param {ExclusiveProcessHooks} [hooks]
     */
    constructor(procedure, hooks) {
        if (this.__brand !== undefined) {
            throw new Error("ExclusiveProcess is a nominal type");
        }
        /** @type {Function} */
        this._procedure = procedure;
        /** @type {((newArgs: unknown[], currentArgs: unknown[]) => void) | null} */
        this._onAttach = hooks?.onAttach ?? null;
        /** @type {((currentArgs: unknown[], newArgs: unknown[]) => boolean) | null} */
        this._shouldQueue = hooks?.shouldQueue ?? null;
        /** @type {Promise<T> | null} */
        this._currentPromise = null;
        /** @type {unknown[] | null} */
        this._currentArgs = null;
        // Pending (queued) invocation
        /** @type {unknown[] | null} */
        this._pendingArgs = null;
        /** @type {((value: T) => void) | null} */
        this._pendingResolve = null;
        /** @type {((reason: unknown) => void) | null} */
        this._pendingReject = null;
        /** @type {Promise<T> | null} */
        this._pendingPromise = null;
    }

    /**
     * Returns `true` if a computation is currently active.
     * @returns {boolean}
     */
    isRunning() {
        return this._currentPromise !== null;
    }

    /**
     * Invoke the managed computation.
     *
     * @param {unknown[]} args - Arguments forwarded to the fixed procedure when starting.
     * @returns {ExclusiveProcessHandleClass<T>}
     */
    invoke(args) {
        if (this._currentPromise === null) {
            return this._startRun(args);
        }

        // Decide: queue or attach?
        if (this._shouldQueue !== null && this._shouldQueue(this._currentArgs ?? [], args)) {
            if (this._pendingPromise === null) {
                /** @type {(value: T) => void} */
                let resolve = (_v) => {};
                /** @type {(reason: unknown) => void} */
                let reject = (_r) => {};
                /** @type {Promise<T>} */
                const promise = new Promise((res, rej) => {
                    resolve = res;
                    reject = rej;
                });
                this._pendingArgs = args;
                this._pendingResolve = resolve;
                this._pendingReject = reject;
                this._pendingPromise = promise;
            } else {
                // Last-write-wins for queued args.
                this._pendingArgs = args;
            }
            return new ExclusiveProcessHandleClass(false, this._pendingPromise);
        }

        // Attach to the running computation.
        this._onAttach?.(args, /** @type {unknown[]} */ (this._currentArgs));
        return new ExclusiveProcessHandleClass(false, this._currentPromise);
    }

    /**
     * Start a fresh run with the given args.
     *
     * @param {unknown[]} args
     * @returns {ExclusiveProcessHandleClass<T>}
     */
    _startRun(args) {
        this._currentArgs = args;

        /** @type {(value: T) => void} */
        let resolve = (_v) => {};
        /** @type {(reason: unknown) => void} */
        let reject = (_r) => {};
        /** @type {Promise<T>} */
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        this._currentPromise = promise;

        let procedurePromise;
        try {
            procedurePromise = this._procedure(...args);
        } catch (error) {
            this._currentPromise = null;
            this._currentArgs = null;
            reject(error);
            this._drainPending();
            return new ExclusiveProcessHandleClass(true, promise);
        }

        procedurePromise.then(
            /** @param {T} result */
            (result) => {
                this._currentPromise = null;
                this._currentArgs = null;
                resolve(result);
                this._drainPending();
            },
            /** @param {unknown} error */
            (error) => {
                this._currentPromise = null;
                this._currentArgs = null;
                reject(error);
                this._drainPending();
            }
        );

        return new ExclusiveProcessHandleClass(true, promise);
    }

    /**
     * After a run ends, start the pending (queued) invocation if any.
     */
    _drainPending() {
        if (this._pendingPromise === null) return;
        const args = /** @type {unknown[]} */ (this._pendingArgs);
        const pendingResolve = /** @type {(value: T) => void} */ (this._pendingResolve);
        const pendingReject = /** @type {(reason: unknown) => void} */ (this._pendingReject);
        this._pendingArgs = null;
        this._pendingResolve = null;
        this._pendingReject = null;
        this._pendingPromise = null;
        const handle = this._startRun(args);
        handle.result.then(pendingResolve, pendingReject);
    }
}

/**
 * Creates a new {@link ExclusiveProcessClass} instance with a fixed procedure.
 *
 * @template T
 * @param {(...args: any[]) => Promise<T>} procedure - The procedure to run.
 * @param {ExclusiveProcessHooks} [hooks]
 * @returns {ExclusiveProcessClass<T>}
 */
function makeExclusiveProcess(procedure, hooks) {
    return new ExclusiveProcessClass(procedure, hooks);
}

/**
 * @param {unknown} object
 * @returns {object is ExclusiveProcessClass<unknown>}
 */
function isExclusiveProcess(object) {
    return object instanceof ExclusiveProcessClass;
}

/**
 * @param {unknown} object
 * @returns {object is ExclusiveProcessHandleClass<unknown>}
 */
function isExclusiveProcessHandle(object) {
    return object instanceof ExclusiveProcessHandleClass;
}

module.exports = {
    makeExclusiveProcess,
    isExclusiveProcess,
    isExclusiveProcessHandle,
};
