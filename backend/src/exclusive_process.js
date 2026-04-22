/**
 * ExclusiveProcess — a state-based abstraction ensuring only one instance of
 * an async computation runs at a time, with shared mutable state and subscriber
 * notifications.
 *
 * ## Construction
 *
 * `makeExclusiveProcess({ initialState, procedure, conflictor })` where:
 *
 * - `initialState: S` — the initial state value returned by `getState()` before
 *   any run starts.
 *
 * - `procedure(mutateState, arg)` — the async computation to run.  Must return
 *   a `Promise<T>`.  `mutateState(fn)` applies `fn` to the current state,
 *   writes the result, and notifies all currently registered subscribers.
 *   - **Sync transformer** (`fn` returns a plain value, not a Promise): state
 *     is updated SYNCHRONOUSLY before any microtask; subscriber notifications
 *     are fire-and-forget.
 *   - **Async transformer** (`fn` returns a `Promise`): the Promise is awaited,
 *     then state is updated, then subscribers are notified (fire-and-forget).
 *   `arg` is the invocation-specific argument.
 *
 * - `conflictor(initiating, attaching)` — called when `invoke` arrives while a
 *   run is already in progress.  Returns `"queue"` to queue the new call behind
 *   the current run or `"attach"` to coalesce it onto the current run.
 *
 * ## Invocation
 *
 * `ep.invoke(arg, subscriber?)` — pass the argument and an optional subscriber
 * `(state: S) => void | Promise<void>` called after each `mutateState`.
 *
 * | State before call | `conflictor` decision | Behaviour |
 * |---|---|---|
 * | Idle | — | Starts a fresh run; caller is the *initiator* |
 * | Running | `"attach"` | Coalesces onto current run; subscriber added |
 * | Running | `"queue"` | Queued; starts after current run ends |
 *
 * Returns a discriminated union handle:
 * - **Initiator**: `{ isInitiator: true, mutateState, result: Promise<T> }`
 *   — the same `mutateState` passed to the procedure.
 * - **Attacher / Queued**: `{ isInitiator: false, currentState: S, result: Promise<T> }`
 *   — `currentState` is the state at invocation time.
 *
 * For queued calls: last-write-wins on `arg`; all queued callers' subscribers
 * are composed so every queued caller receives state notifications.
 *
 * After the computation finishes the ExclusiveProcess resets to idle.
 *
 * ## State
 *
 * `ep.getState()` returns the current state `S`.  For sync transformers the
 * state is updated before `invoke` returns, so callers can read the new state
 * immediately after `invoke`.
 *
 * @module exclusive_process
 */

// ─── Handle classes ───────────────────────────────────────────────────────────

/**
 * Common base for all handle types — used only by `isExclusiveProcessHandle`.
 */
class ExclusiveProcessHandleBaseClass {
    /** @type {undefined} */
    __brand = undefined;

    constructor() {
        if (this.__brand !== undefined) {
            throw new Error("ExclusiveProcessHandle is a nominal type");
        }
    }
}

/**
 * Handle returned to the *initiator* of a fresh run.
 *
 * @template S - State type.
 * @template T - Return type of the procedure.
 */
class InitiatorHandleClass extends ExclusiveProcessHandleBaseClass {
    /**
     * @param {(fn: (state: S) => S | Promise<S>) => Promise<void>} mutateState
     * @param {Promise<T>} result
     */
    constructor(mutateState, result) {
        super();
        /** @type {true} */
        this.isInitiator = true;
        /** @type {(fn: (state: S) => S | Promise<S>) => Promise<void>} */
        this.mutateState = mutateState;
        /** @type {Promise<T>} */
        this.result = result;
    }
}

/**
 * Handle returned to an *attacher* or *queued* caller.
 *
 * @template S - State type.
 * @template T - Return type of the procedure.
 */
class AttacherHandleClass extends ExclusiveProcessHandleBaseClass {
    /**
     * @param {S} currentState
     * @param {Promise<T>} result
     */
    constructor(currentState, result) {
        super();
        /** @type {false} */
        this.isInitiator = false;
        /** @type {S} */
        this.currentState = currentState;
        /** @type {Promise<T>} */
        this.result = result;
    }
}

// ─── ExclusiveProcess class ───────────────────────────────────────────────────

/** @typedef {import('./logger').Logger} Logger */
/** @typedef {{ logger: Logger }} CapabilitiesWithLogger */

/**
 * Ensures only one instance of an async computation runs at a time, with
 * shared mutable state and subscriber notifications.
 *
 * @template A - Type of the single argument passed to the procedure.
 * @template T - Return type of the procedure.
 * @template [S=undefined] - State type.
 */
class ExclusiveProcessClass {
    /** @type {undefined} */
    __brand = undefined;

    /**
     * @param {S} initialState
     * @param {(mutateState: (fn: (state: S) => S | Promise<S>) => Promise<void>, arg: A) => Promise<T>} procedure
     * @param {(initiating: A, attaching: A) => "attach" | "queue"} conflictor
     * @param {(arg: A) => CapabilitiesWithLogger} getCapabilities
     */
    constructor(initialState, procedure, conflictor, getCapabilities) {
        if (this.__brand !== undefined) {
            throw new Error("ExclusiveProcess is a nominal type");
        }
        /** @type {S} */
        this._state = initialState;
        /** @type {Function} */
        this._procedure = procedure;
        /** @type {(initiating: A, attaching: A) => "attach" | "queue"} */
        this._conflictor = conflictor;
        /** @type {(arg: A) => CapabilitiesWithLogger} */
        this._getCapabilities = getCapabilities;
        /** @type {Promise<T> | null} */
        this._currentPromise = null;
        /** @type {{ value: A } | null} */
        this._currentArgHolder = null;
        /** @type {((state: S) => void | Promise<void>)[]} */
        this._subscribers = [];
        // Queued (pending) invocation state
        /** @type {{ value: A } | null} */
        this._pendingArgHolder = null;
        /**
         * Composed subscriber for the pending run.  When multiple conflicting
         * calls arrive, last-write-wins on the arg but all subscribers are
         * composed so every queued caller receives state notifications.
         * @type {((state: S) => void | Promise<void>) | null}
         */
        this._pendingSubscriber = null;
        /** @type {((value: T) => void) | null} */
        this._pendingResolve = null;
        /** @type {((reason: unknown) => void) | null} */
        this._pendingReject = null;
        /** @type {Promise<T> | null} */
        this._pendingPromise = null;
    }

    /**
     * Returns the current state.
     * @returns {S}
     */
    getState() {
        return this._state;
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
     * @param {((state: S) => void | Promise<void>) | null} [subscriber] - Optional subscriber.
     * @returns {InitiatorHandleClass<S, T> | AttacherHandleClass<S, T>}
     */
    invoke(arg, subscriber) {
        const sub = subscriber ?? null;

        if (this._currentPromise === null) {
            return this._startRun(arg, sub);
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
                    this._pendingSubscriber = sub;
                    this._pendingResolve = resolve;
                    this._pendingReject = reject;
                    this._pendingPromise = promise;
                    return new AttacherHandleClass(this._state, promise);
                } else {
                    // Subsequent queued calls: last-write-wins on arg;
                    // compose subscribers so all queued callers receive notifications.
                    this._pendingArgHolder = { value: arg };
                    if (sub !== null) {
                        const existing = this._pendingSubscriber;
                        if (existing === null) {
                            this._pendingSubscriber = sub;
                        } else {
                            const capturedExisting = existing;
                            this._pendingSubscriber = (state) => {
                                capturedExisting(state);
                                sub(state);
                            };
                        }
                    }
                    const pendingPromise = this._pendingPromise;
                    if (pendingPromise === null) {
                        throw new Error(
                            "ExclusiveProcess invariant violated: pendingPromise is null in queue branch"
                        );
                    }
                    return new AttacherHandleClass(this._state, pendingPromise);
                }
            }
        }

        // Attach to the running computation.
        if (sub !== null) {
            this._subscribers.push(sub);
        }
        const currentPromise = this._currentPromise;
        if (currentPromise === null) {
            throw new Error(
                "ExclusiveProcess invariant violated: currentPromise is null in attach branch"
            );
        }
        return new AttacherHandleClass(this._state, currentPromise);
    }

    /**
     * Notify all current subscribers with the new state.
     * Synchronous: subscribers are called immediately; async subscriber
     * Promises are fire-and-forget (errors caught and logged).
     *
     * @param {((state: S) => void | Promise<void>)[]} subscribers
     * @param {S} state
     * @param {CapabilitiesWithLogger} capabilities
     */
    _notifySubscribers(subscribers, state, capabilities) {
        for (const sub of subscribers) {
            try {
                const maybePromise = sub(state);
                if (maybePromise instanceof Promise) {
                    maybePromise.then(undefined, (err) => {
                        capabilities.logger.logError({ error: err }, "ExclusiveProcess: async subscriber error");
                    });
                }
            } catch (err) {
                capabilities.logger.logError({ error: err }, "ExclusiveProcess: subscriber threw an error");
            }
        }
    }

    /**
     * Start a fresh run.
     *
     * @param {A} arg
     * @param {((state: S) => void | Promise<void>) | null} subscriber
     * @returns {InitiatorHandleClass<S, T>}
     */
    _startRun(arg, subscriber) {
        this._currentArgHolder = { value: arg };

        // Capture a per-run array in the `mutateState` closure so that state
        // mutations after the run ends cannot leak into a later run's subscriber
        // set.  Attachers push into `this._subscribers`, which is the same
        // object as `subscribers` for the duration of this run.
        /** @type {((state: S) => void | Promise<void>)[]} */
        const subscribers = subscriber !== null ? [subscriber] : [];
        this._subscribers = subscribers;

        // Extract the capabilities for this run from the arg.
        /** @type {CapabilitiesWithLogger} */
        const capabilities = this._getCapabilities(arg);

        /**
         * Promise chain used to serialize *queued* state mutations for this run
         * so each transformer observes the latest committed state and commits in
         * call order.
         * @type {Promise<void>}
         */
        let pendingMutation = Promise.resolve();
        /** @type {number} */
        let pendingMutationCount = 0;
        /** @type {boolean} */
        let isRunActive = true;

        /**
         * Applies `fn` to the current state, writes the result, and notifies
         * all current subscribers.
         *
         * Mutations are serialized per run, including async transformers, so
         * concurrent callers cannot overwrite newer state with older results.
         *
         * For backwards-compatibility with the new API contract, if there is no
         * pending mutation and `fn` is synchronous, the state update is still
         * applied synchronously before `mutateState` returns.
         *
         * @param {(state: S) => S | Promise<S>} fn
         * @returns {Promise<void>}
         */
        const mutateState = (fn) => {
            if (!isRunActive) {
                return Promise.resolve();
            }

            if (pendingMutationCount === 0) {
                const fnResult = fn(this._state);
                if (!(fnResult instanceof Promise)) {
                    // Preserve synchronous update behavior for sync transformers.
                    this._state = fnResult;
                    this._notifySubscribers(subscribers, fnResult, capabilities);
                    return Promise.resolve();
                }

                pendingMutationCount += 1;
                const asyncMutationPromise = fnResult.then((newState) => {
                    if (!isRunActive) return;
                    this._state = newState;
                    this._notifySubscribers(subscribers, newState, capabilities);
                });
                pendingMutation = asyncMutationPromise.then(
                    () => {
                        pendingMutationCount -= 1;
                    },
                    () => {
                        pendingMutationCount -= 1;
                    }
                );
                return asyncMutationPromise;
            }

            const mutationPromise = pendingMutation.then(() => {
                if (!isRunActive) {
                    return;
                }
                return Promise.resolve(fn(this._state)).then((newState) => {
                    if (!isRunActive) return;
                    this._state = newState;
                    this._notifySubscribers(subscribers, newState, capabilities);
                });
            });

            pendingMutationCount += 1;
            // Keep later mutations flowing even if this one fails, while still
            // returning the original result to the current caller.
            pendingMutation = mutationPromise.then(
                () => {
                    pendingMutationCount -= 1;
                },
                () => {
                    pendingMutationCount -= 1;
                }
            );
            return mutationPromise;
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

        const procedurePromise = this._procedure(mutateState, arg);

        procedurePromise.then(
            /** @param {T} result */
            (result) => {
                isRunActive = false;
                this._currentPromise = null;
                this._currentArgHolder = null;
                this._subscribers = [];
                subscribers.length = 0;
                resolve(result);
                this._drainPending();
            },
            /** @param {unknown} error */
            (error) => {
                isRunActive = false;
                this._currentPromise = null;
                this._currentArgHolder = null;
                this._subscribers = [];
                subscribers.length = 0;
                reject(error);
                this._drainPending();
            }
        );

        return new InitiatorHandleClass(mutateState, promise);
    }

    /**
     * After a run ends, start the pending (queued) invocation if any.
     */
    _drainPending() {
        if (this._pendingPromise === null) return;

        const argHolder = this._pendingArgHolder;
        const pendingSubscriber = this._pendingSubscriber;
        const pendingResolve = this._pendingResolve;
        const pendingReject = this._pendingReject;

        if (argHolder === null || pendingResolve === null || pendingReject === null) {
            throw new Error(
                "ExclusiveProcess internal invariant violated: " +
                "pending promise exists but pending arg/resolve/reject are null"
            );
        }

        this._pendingArgHolder = null;
        this._pendingSubscriber = null;
        this._pendingResolve = null;
        this._pendingReject = null;
        this._pendingPromise = null;

        const handle = this._startRun(argHolder.value, pendingSubscriber);
        handle.result.then(pendingResolve, pendingReject);
    }
}

/**
 * Creates a new {@link ExclusiveProcessClass} instance.
 *
 * @template A - Type of the single argument passed to the procedure.
 * @template T - Return type of the procedure.
 * @template [S=undefined] - State type.
 * @param {{ initialState: S, procedure: (mutateState: (fn: (state: S) => S | Promise<S>) => Promise<void>, arg: A) => Promise<T>, conflictor: (initiating: A, attaching: A) => "attach" | "queue", getCapabilities: (arg: A) => CapabilitiesWithLogger }} options
 * @returns {ExclusiveProcessClass<A, T, S>}
 */
function makeExclusiveProcess(options) {
    return new ExclusiveProcessClass(
        options.initialState,
        options.procedure,
        options.conflictor,
        options.getCapabilities
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
 * @returns {object is InitiatorHandleClass<unknown, unknown> | AttacherHandleClass<unknown, unknown>}
 */
function isExclusiveProcessHandle(object) {
    return object instanceof ExclusiveProcessHandleBaseClass;
}

module.exports = {
    makeExclusiveProcess,
    isExclusiveProcess,
    isExclusiveProcessHandle,
};
