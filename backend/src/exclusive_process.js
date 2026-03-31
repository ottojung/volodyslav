/**
 * ExclusiveProcess — an abstraction that ensures only one instance of an async
 * computation runs at a time.
 *
 * When `invoke(procedure)` is called while no computation is active, the
 * procedure is started and the caller receives a handle marked as the
 * *initiator*.
 *
 * When `invoke(procedure)` is called while a computation is already running,
 * the new procedure is **ignored** and the caller receives a handle marked as
 * an *attacher*.  Both the initiator and all attachers share the same result
 * promise, so they all learn of success or failure in the same way.
 *
 * After the computation finishes (successfully or with an error) the
 * ExclusiveProcess resets to its idle state so that a subsequent `invoke`
 * starts a new computation.
 *
 * @module exclusive_process
 */

/**
 * A handle returned by {@link ExclusiveProcessClass#invoke}.
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
 *
 * @template T
 */
class ExclusiveProcessClass {
    /** @type {undefined} */
    __brand = undefined;

    constructor() {
        if (this.__brand !== undefined) {
            throw new Error("ExclusiveProcess is a nominal type");
        }
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
     * If no computation is currently active, `procedure` is called and this
     * caller becomes the *initiator*.  If a computation is already running,
     * `procedure` is ignored and this caller becomes an *attacher*.  In both
     * cases the returned handle's `result` promise resolves or rejects with
     * the outcome of the active computation.
     *
     * A crash inside `procedure` rejects `result` for **all** current callers
     * and resets the ExclusiveProcess so that the next `invoke` can start a
     * fresh computation.
     *
     * @param {() => Promise<T>} procedure
     * @returns {ExclusiveProcessHandleClass<T>}
     */
    invoke(procedure) {
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

        // Start the procedure.  If procedure() itself throws synchronously we
        // must still clear _currentPromise so the next invoke can start fresh.
        let procedurePromise;
        try {
            procedurePromise = procedure();
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
 * Creates a new {@link ExclusiveProcessClass} instance.
 *
 * @template T
 * @returns {ExclusiveProcessClass<T>}
 */
function makeExclusiveProcess() {
    return new ExclusiveProcessClass();
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
