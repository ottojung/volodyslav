/**
 * ExclusiveProcess — an abstraction that ensures only one instance of an async
 * computation runs at a time, with native callback fan-out.
 *
 * ## Construction
 *
 * `makeExclusiveProcess(procedure, shouldQueue?)` where `procedure` is a
 * curried function:
 *
 *   `(fanOut: (cbArg: C) => void) => (arg: A) => Promise<T>`
 *
 * The `fanOut` parameter is a class-managed wrapper that distributes each
 * callback event to every currently registered caller (initiator and all
 * attachers).  The procedure should call `fanOut(event)` instead of calling
 * individual caller callbacks directly.
 *
 * ## Invocation
 *
 * `ep.invoke(arg, callerCallback?)` — pass the argument and an optional
 * per-caller callback.
 *
 * | State before call | Behaviour |
 * |---|---|
 * | Idle | Starts a fresh run; caller is the *initiator* |
 * | Running, compatible | Attaches to the running computation; caller is an *attacher* |
 * | Running, conflicting (shouldQueue returns true) | Queues behind the current run |
 *
 * Both initiator and all attachers share the same result promise.  All
 * registered callbacks (from every attaching caller) receive every event
 * emitted via `fanOut`.
 *
 * After the computation finishes (successfully or with an error) the
 * ExclusiveProcess resets to idle so the next `invoke` starts a fresh run.
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
 * Ensures only one instance of an async computation runs at a time, with
 * native callback fan-out.
 *
 * @template A - Type of the single argument passed to the procedure.
 * @template T - Return type of the procedure.
 * @template [C=never] - Type of each callback event emitted by the procedure.
 */
class ExclusiveProcessClass {
    /** @type {undefined} */
    __brand = undefined;

    /**
     * @param {(fanOut: (cbArg: C) => void) => (arg: A) => Promise<T>} procedure
     * @param {((currentArg: A, newArg: A) => boolean) | null} [shouldQueue]
     */
    constructor(procedure, shouldQueue) {
        if (this.__brand !== undefined) {
            throw new Error("ExclusiveProcess is a nominal type");
        }
        /** @type {Function} */
        this._procedure = procedure;
        /** @type {((currentArg: A, newArg: A) => boolean) | null} */
        this._shouldQueue = shouldQueue ?? null;
        /** @type {Promise<T> | null} */
        this._currentPromise = null;
        /** @type {{ value: A } | null} */
        this._currentArgHolder = null;
        /** @type {((cbArg: C) => void)[]} */
        this._callbackReceivers = [];
        // Queued (pending) invocation
        /** @type {{ value: A } | null} */
        this._pendingArgHolder = null;
        /** @type {((cbArg: C) => void) | null} */
        this._pendingCallback = null;
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
     * If the process is idle, starts a fresh run and returns an initiator
     * handle.  If running:
     * - If `shouldQueue` returns `true` for the (current, new) arg pair, the
     *   call is queued (last-write-wins when multiple calls queue up) and
     *   returns an attacher handle backed by the pending run's promise.
     * - Otherwise attaches to the running computation and returns an attacher
     *   handle backed by the current run's promise.
     *
     * @param {A} arg - Argument forwarded to the procedure when starting.
     * @param {((cbArg: C) => void) | null} [callerCallback] - Optional per-caller callback.
     * @returns {ExclusiveProcessHandleClass<T>}
     */
    invoke(arg, callerCallback) {
        const cb = callerCallback ?? null;

        if (this._currentPromise === null) {
            return this._startRun(arg, cb);
        }

        // Decide: queue or attach?
        if (this._shouldQueue !== null) {
            const currentArgHolder = this._currentArgHolder;
            if (
                currentArgHolder !== null &&
                this._shouldQueue(currentArgHolder.value, arg)
            ) {
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
                    this._pendingArgHolder = { value: arg };
                    this._pendingCallback = cb;
                    this._pendingResolve = resolve;
                    this._pendingReject = reject;
                    this._pendingPromise = promise;
                } else {
                    // Last-write-wins for queued arg and callback.
                    this._pendingArgHolder = { value: arg };
                    this._pendingCallback = cb;
                }
                return new ExclusiveProcessHandleClass(false, this._pendingPromise);
            }
        }

        // Attach to the running computation.
        if (cb !== null) {
            this._callbackReceivers.push(cb);
        }
        return new ExclusiveProcessHandleClass(false, this._currentPromise);
    }

    /**
     * Start a fresh run.
     *
     * @param {A} arg
     * @param {((cbArg: C) => void) | null} callerCallback
     * @returns {ExclusiveProcessHandleClass<T>}
     */
    _startRun(arg, callerCallback) {
        this._currentArgHolder = { value: arg };
        this._callbackReceivers = callerCallback !== null ? [callerCallback] : [];

        /** @type {(cbArg: C) => void} */
        const fanOut = (cbArg) => {
            for (const cb of this._callbackReceivers) cb(cbArg);
        };

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
            procedurePromise = this._procedure(fanOut)(arg);
        } catch (error) {
            this._currentPromise = null;
            this._currentArgHolder = null;
            this._callbackReceivers = [];
            reject(error);
            this._drainPending();
            return new ExclusiveProcessHandleClass(true, promise);
        }

        procedurePromise.then(
            /** @param {T} result */
            (result) => {
                this._currentPromise = null;
                this._currentArgHolder = null;
                this._callbackReceivers = [];
                resolve(result);
                this._drainPending();
            },
            /** @param {unknown} error */
            (error) => {
                this._currentPromise = null;
                this._currentArgHolder = null;
                this._callbackReceivers = [];
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
        const argHolder = /** @type {{ value: A }} */ (this._pendingArgHolder);
        const callback = this._pendingCallback;
        const pendingResolve = /** @type {(value: T) => void} */ (this._pendingResolve);
        const pendingReject = /** @type {(reason: unknown) => void} */ (this._pendingReject);
        this._pendingArgHolder = null;
        this._pendingCallback = null;
        this._pendingResolve = null;
        this._pendingReject = null;
        this._pendingPromise = null;
        const handle = this._startRun(argHolder.value, callback);
        handle.result.then(pendingResolve, pendingReject);
    }
}

/**
 * Creates a new {@link ExclusiveProcessClass} instance.
 *
 * @template A - Type of the single argument passed to the procedure.
 * @template T - Return type of the procedure.
 * @template [C=never] - Type of each callback event emitted by the procedure.
 * @param {(fanOut: (cbArg: C) => void) => (arg: A) => Promise<T>} procedure
 *   Curried function: first receives the class-managed fan-out callback, then
 *   the invocation argument.  The procedure should call `fanOut(event)` to
 *   broadcast progress events to all current callers.
 * @param {((currentArg: A, newArg: A) => boolean) | null} [shouldQueue]
 *   If provided and returns `true` for a (currentArg, newArg) pair, the new
 *   call is queued rather than attached.  Last-write-wins when multiple calls
 *   queue up.
 * @returns {ExclusiveProcessClass<A, T, C>}
 */
function makeExclusiveProcess(procedure, shouldQueue) {
    return new ExclusiveProcessClass(procedure, shouldQueue ?? null);
}

/**
 * @param {unknown} object
 * @returns {object is ExclusiveProcessClass<unknown, unknown, unknown>}
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
