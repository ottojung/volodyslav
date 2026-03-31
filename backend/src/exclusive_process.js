/**
 * ExclusiveProcess — an abstraction that ensures only one instance of an async
 * computation runs at a time, with native callback fan-out.
 *
 * ## Construction
 *
 * `makeExclusiveProcess({ name, procedure, conflictor, owner?, getHostname? })` where:
 *
 * - `name` — a human-readable name used in diagnostics and error messages.
 *
 * - `procedure(fanOut, arg)` — the async computation to run.  Must return a
 *   `Promise<T>`.  `fanOut` is a class-managed callback that distributes each
 *   progress event to every currently registered caller (initiator and all
 *   attachers).  `arg` is the invocation-specific argument.
 *
 * - `conflictor(initiating, attaching)` — called when `invoke` arrives while a
 *   run is already in progress.  Returns `"queue"` to queue the new call behind
 *   the current run or `"attach"` to coalesce it onto the current run.  Pass
 *   `() => "attach"` to always attach (no queuing).
 *
 * - `owner` (optional) — a lazy `() => string | null` callback.  When it
 *   returns a non-null string, only the host whose hostname equals that string
 *   is allowed to invoke this process.  A non-owner caller receives a
 *   `NotProcessOwnerError` instead of a handle.
 *
 * - `getHostname` (optional) — a lazy `() => string` callback that returns the
 *   current hostname.  Required when `owner` is provided.
 *
 * ## Invocation
 *
 * `ep.invoke(arg, callerCallback?)` — pass the argument and an optional
 * per-caller callback.
 *
 * | State before call | `conflictor` decision | Behaviour |
 * |---|---|---|
 * | Idle | — | Starts a fresh run; caller is the *initiator* |
 * | Running | `"attach"` | Coalesces onto current run; `callerCallback` added to fan-out |
 * | Running | `"queue"` | Queued; starts after current run ends |
 *
 * Both initiator and all attachers share the same result promise.  All
 * registered callbacks receive every event emitted via `fanOut`.
 *
 * For queued calls: last-write-wins on `arg` (most recent queued arg is used
 * when the queued run starts), but **all** queued callers' callbacks are
 * composed so every caller receives events from the queued run.
 *
 * After the computation finishes (successfully or with an error) the
 * ExclusiveProcess resets to idle so the next `invoke` starts a fresh run.
 *
 * @module exclusive_process
 */

/**
 * Thrown by `invoke` when the current host is not the designated owner of an
 * exclusive process.
 */
class NotProcessOwnerError extends Error {
    /**
     * @param {string} processName - The name of the exclusive process.
     * @param {string} allowedOwner - The hostname that is permitted to invoke.
     * @param {string} actualHostname - The hostname of the current host.
     */
    constructor(processName, allowedOwner, actualHostname) {
        super(
            `Process "${processName}" can only be invoked by "${allowedOwner}", ` +
            `but the current host is "${actualHostname}"`
        );
        this.name = "NotProcessOwnerError";
        /** @type {string} */
        this.processName = processName;
        /** @type {string} */
        this.allowedOwner = allowedOwner;
        /** @type {string} */
        this.actualHostname = actualHostname;
    }
}

/**
 * @param {unknown} object
 * @returns {object is NotProcessOwnerError}
 */
function isNotProcessOwnerError(object) {
    return object instanceof NotProcessOwnerError;
}

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
 * @template [C=never] - Type of each progress event emitted via `fanOut`.
 */
class ExclusiveProcessClass {
    /** @type {undefined} */
    __brand = undefined;

    /**
     * @param {string} name
     * @param {(fanOut: (cbArg: C) => void, arg: A) => Promise<T>} procedure
     * @param {(initiating: A, attaching: A) => "attach" | "queue"} conflictor
     * @param {(() => string | null) | null} owner
     * @param {(() => string) | null} getHostname
     */
    constructor(name, procedure, conflictor, owner, getHostname) {
        if (this.__brand !== undefined) {
            throw new Error("ExclusiveProcess is a nominal type");
        }
        /** @type {string} */
        this._name = name;
        /** @type {Function} */
        this._procedure = procedure;
        /** @type {(initiating: A, attaching: A) => "attach" | "queue"} */
        this._conflictor = conflictor;
        /** @type {(() => string | null) | null} */
        this._owner = owner;
        /** @type {(() => string) | null} */
        this._getHostname = getHostname;
        /** @type {Promise<T> | null} */
        this._currentPromise = null;
        /** @type {{ value: A } | null} */
        this._currentArgHolder = null;
        /** @type {((cbArg: C) => void)[]} */
        this._callbackReceivers = [];
        // Queued (pending) invocation state
        /** @type {{ value: A } | null} */
        this._pendingArgHolder = null;
        /**
         * Composed callback for the pending run.  When multiple conflicting
         * calls arrive, last-write-wins on the arg but all callbacks are
         * composed so every queued caller receives fan-out events.
         * @type {((cbArg: C) => void) | null}
         */
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
     * @param {A} arg - Argument forwarded to the procedure when starting.
     * @param {((cbArg: C) => void) | null} [callerCallback] - Optional per-caller callback.
     * @returns {ExclusiveProcessHandleClass<T>}
     */
    invoke(arg, callerCallback) {
        // Ownership check: if this process has an owner, verify the current
        // hostname matches before allowing the invocation to proceed.
        if (this._owner !== null) {
            const owner = this._owner();
            if (owner !== null) {
                const getHostname = this._getHostname;
                if (getHostname === null) {
                    throw new Error(
                        `ExclusiveProcess "${this._name}" has an owner but no getHostname callback was provided`
                    );
                }
                const hostname = getHostname();
                if (hostname !== owner) {
                    throw new NotProcessOwnerError(this._name, owner, hostname);
                }
            }
        }

        const cb = callerCallback ?? null;

        if (this._currentPromise === null) {
            return this._startRun(arg, cb);
        }

        // A run is active — ask the conflictor whether to attach or queue.
        const currentArgHolder = this._currentArgHolder;
        if (currentArgHolder !== null) {
            const decision = this._conflictor(currentArgHolder.value, arg);
            if (decision === "queue") {
                if (this._pendingPromise === null) {
                    // First queued call: create a new pending promise.
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
                    return new ExclusiveProcessHandleClass(false, promise);
                } else {
                    // Subsequent queued calls: last-write-wins on arg;
                    // compose callbacks so all queued callers receive events.
                    this._pendingArgHolder = { value: arg };
                    if (cb !== null) {
                        const existing = this._pendingCallback;
                        if (existing === null) {
                            this._pendingCallback = cb;
                        } else {
                            // Capture `existing` in the closure; `this._pendingCallback`
                            // will be overwritten immediately after this block.
                            this._pendingCallback = (event) => {
                                existing(event);
                                cb(event);
                            };
                        }
                    }
                    const pendingPromise = this._pendingPromise;
                    if (pendingPromise === null) {
                        throw new Error(
                            "ExclusiveProcess invariant violated: pendingPromise is null in queue branch"
                        );
                    }
                    return new ExclusiveProcessHandleClass(false, pendingPromise);
                }
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

        // Capture a per-run array in the `fanOut` closure so that async
        // progress events emitted after the run ends cannot leak into a later
        // run's callback set.  Attachers push into `this._callbackReceivers`,
        // which is the same object as `receivers` for the duration of this run.
        /** @type {((cbArg: C) => void)[]} */
        const receivers = callerCallback !== null ? [callerCallback] : [];
        this._callbackReceivers = receivers;

        /** @type {(cbArg: C) => void} */
        const fanOut = (cbArg) => {
            for (const cb of receivers) {
                try {
                    cb(cbArg);
                } catch (error) {
                    // ExclusiveProcess is a generic utility with no access to
                    // capabilities, so we fall back to console.error here.
                    // This keeps one caller's callback bug from aborting the
                    // run for everyone else.
                    console.error("ExclusiveProcess: fan-out callback threw an error", error);
                }
            }
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

        /** @type {Promise<T>} */
        const procedurePromise = this._procedure(fanOut, arg);

        procedurePromise.then(
            /** @param {T} result */
            (result) => {
                this._currentPromise = null;
                this._currentArgHolder = null;
                this._callbackReceivers = [];
                receivers.length = 0;
                resolve(result);
                this._drainPending();
            },
            /** @param {unknown} error */
            (error) => {
                this._currentPromise = null;
                this._currentArgHolder = null;
                this._callbackReceivers = [];
                receivers.length = 0;
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

        const argHolder = this._pendingArgHolder;
        const callback = this._pendingCallback;
        const pendingResolve = this._pendingResolve;
        const pendingReject = this._pendingReject;

        if (argHolder === null || pendingResolve === null || pendingReject === null) {
            throw new Error(
                "ExclusiveProcess internal invariant violated: " +
                "pending promise exists but pending arg/resolve/reject are null"
            );
        }

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
 * @template [C=never] - Type of each progress event emitted via `fanOut`.
 * @param {{
 *   name: string,
 *   procedure: (fanOut: (cbArg: C) => void, arg: A) => Promise<T>,
 *   conflictor: (initiating: A, attaching: A) => "attach" | "queue",
 *   owner?: (() => string | null) | null,
 *   getHostname?: (() => string) | null,
 * }} options
 * @returns {ExclusiveProcessClass<A, T, C>}
 */
function makeExclusiveProcess(options) {
    return new ExclusiveProcessClass(
        options.name,
        options.procedure,
        options.conflictor,
        options.owner ?? null,
        options.getHostname ?? null,
    );
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
    NotProcessOwnerError,
    isNotProcessOwnerError,
};
