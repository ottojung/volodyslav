/**
 * ExclusiveProcess — an abstraction that ensures only one instance of an async
 * computation runs at a time.
 *
 * Each ExclusiveProcess is created with a **fixed procedure**.  When
 * `invoke(args)` is called while no computation is active, the procedure is
 * called with the supplied args and the caller receives a handle marked as the
 * *initiator*.
 *
 * When `invoke(args)` is called while a computation is already running, the
 * args are **not used** (the fixed procedure is not re-invoked) and the caller
 * receives a handle marked as an *attacher*.  Both the initiator and all
 * attachers share the same result promise, so they all learn of success or
 * failure in the same way.
 *
 * After the computation finishes (successfully or with an error) the
 * ExclusiveProcess resets to its idle state so that a subsequent `invoke`
 * starts a new computation.
 *
 * @module exclusive_process
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
     * @param {(...args: unknown[]) => Promise<T>} procedure
     */
    constructor(procedure) {
        if (this.__brand !== undefined) {
            throw new Error("ExclusiveProcess is a nominal type");
        }
        /** @type {(...args: unknown[]) => Promise<T>} */
        this._procedure = procedure;
        /** @type {Promise<T> | null} */
        this._currentPromise = null;
    }

    /**
     * Returns `true` if a computation is currently active, `false` if the
     * process is idle and ready for a new `invoke`.
     *
     * @returns {boolean}
     */
    isRunning() {
        return this._currentPromise !== null;
    }

    /**
     * Invoke the managed computation.
     *
     * If no computation is currently active, the fixed procedure is called
     * with `args` and this caller becomes the *initiator*.  If a computation
     * is already running, `args` are ignored and this caller becomes an
     * *attacher*.  In both cases the returned handle's `result` promise
     * resolves or rejects with the outcome of the active computation.
     *
     * A crash inside the procedure rejects `result` for **all** current callers
     * and resets the ExclusiveProcess so that the next `invoke` can start a
     * fresh computation.
     *
     * @param {unknown[]} args - Arguments forwarded to the fixed procedure when starting.
     * @returns {ExclusiveProcessHandleClass<T>}
     */
    invoke(args) {
        if (this._currentPromise !== null) {
            return new ExclusiveProcessHandleClass(false, this._currentPromise);
        }

        /** @type {(value: T) => void} */
        let resolve = (_value) => {};
        /** @type {(reason: unknown) => void} */
        let reject = (_reason) => {};

        /** @type {Promise<T>} */
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });

        this._currentPromise = promise;

        // Start the procedure.  If it throws synchronously we must still clear
        // _currentPromise so the next invoke can start fresh.
        let procedurePromise;
        try {
            procedurePromise = this._procedure(...args);
        } catch (error) {
            this._currentPromise = null;
            reject(error);
            return new ExclusiveProcessHandleClass(true, promise);
        }

        procedurePromise.then(
            (result) => {
                this._currentPromise = null;
                resolve(result);
            },
            (error) => {
                this._currentPromise = null;
                reject(error);
            }
        );

        return new ExclusiveProcessHandleClass(true, promise);
    }
}

/**
 * Creates a new {@link ExclusiveProcessClass} instance with a fixed procedure.
 *
 * @template T
 * @param {(...args: unknown[]) => Promise<T>} procedure - The procedure to run.
 * @returns {ExclusiveProcessClass<T>}
 */
function makeExclusiveProcess(procedure) {
    return new ExclusiveProcessClass(procedure);
}

/**
 * Creates a handle directly.  Used by specialized ExclusiveProcess wrappers
 * that need to return handles backed by their own promises (e.g. for queued
 * runs with different options).
 *
 * @template T
 * @param {boolean} isInitiator
 * @param {Promise<T>} result
 * @returns {ExclusiveProcessHandleClass<T>}
 */
function makeExclusiveProcessHandle(isInitiator, result) {
    return new ExclusiveProcessHandleClass(isInitiator, result);
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
    makeExclusiveProcessHandle,
    isExclusiveProcess,
    isExclusiveProcessHandle,
};
