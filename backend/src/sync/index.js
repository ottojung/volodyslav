const assets = require("../assets");
const { makeExclusiveProcess, makeExclusiveProcessHandle } = require("../exclusive_process");
/** @typedef {import('../capabilities/root').Capabilities} Capabilities */

// ---------------------------------------------------------------------------
// Per-destination error types
// ---------------------------------------------------------------------------

class AssetsSyncError extends Error {
    /** @param {unknown} cause */
    constructor(cause) {
        super(`Assets sync failed: ${cause}`);
        this.name = "AssetsSyncError";
        this.cause = cause;
    }
}

/** @param {unknown} object @returns {object is AssetsSyncError} */
function isAssetsSyncError(object) {
    return object instanceof AssetsSyncError;
}

class GeneratorsSyncError extends Error {
    /** @param {unknown} cause */
    constructor(cause) {
        super(`Generators database sync failed: ${cause}`);
        this.name = "GeneratorsSyncError";
        this.cause = cause;
    }
}

/** @param {unknown} object @returns {object is GeneratorsSyncError} */
function isGeneratorsSyncError(object) {
    return object instanceof GeneratorsSyncError;
}

// ---------------------------------------------------------------------------
// Aggregate error
// ---------------------------------------------------------------------------

/**
 * @typedef {AssetsSyncError | GeneratorsSyncError} SyncDestinationError
 */

class SynchronizeAllError extends Error {
    /**
     * @param {SyncDestinationError[]} errors
     */
    constructor(errors) {
        super(`Synchronization failed: ${errors.map((e) => e.message).join("; ")}`);
        this.name = "SynchronizeAllError";
        /** @type {SyncDestinationError[]} */
        this.errors = errors;
    }
}

/** @param {unknown} object @returns {object is SynchronizeAllError} */
function isSynchronizeAllError(object) {
    return object instanceof SynchronizeAllError;
}

// ---------------------------------------------------------------------------
// synchronizeAll
// ---------------------------------------------------------------------------

/**
 * @typedef {{ name: string, status: "success" | "error" }} SyncStepResult
 */

/**
 * Returns `true` if the incoming options conflict with the current run's
 * options.  A conflict occurs when the new caller wants to reset to a specific
 * hostname that differs from what the current run is doing (either the current
 * run has no reset, or is resetting to a different hostname).
 *
 * If the new caller has no reset requirement (`resetToHostname` is absent),
 * any ongoing run is acceptable and there is no conflict.
 *
 * @param {{ resetToHostname?: string } | undefined} current
 * @param {{ resetToHostname?: string } | undefined} incoming
 * @returns {boolean}
 */
function _syncOptionsConflict(current, incoming) {
    const incomingReset = incoming?.resetToHostname;
    if (incomingReset === undefined) return false;
    return incomingReset !== current?.resetToHostname;
}

/**
 * Singleton ExclusiveProcess for synchronization.
 *
 * Both the hourly scheduled job and the POST /sync route use this instance.
 *
 * - When a second call is made with **compatible** options (same reset target
 *   or no reset at all), it *attaches* to the running computation and shares
 *   its result.  The attacher's `onStepComplete` callback is added to a
 *   fan-out set so it also receives progress notifications for the remainder
 *   of the run.
 *
 * - When a second call is made with **conflicting** options (the caller wants
 *   a reset that the current run is not performing), it is *queued*: after the
 *   current run finishes the pending call is started automatically.  The
 *   caller's promise resolves only when its own queued run completes.
 *   Last-write-wins if multiple conflicting calls arrive during the same run.
 *
 * This ensures that a `resetToHostname` request from the frontend is never
 * silently dropped because an hourly job happened to be running concurrently.
 */
const synchronizeAllExclusiveProcess = (() => {
    /** @type {{ resetToHostname?: string } | undefined} */
    let currentRunOptions = undefined;
    /** @type {((step: SyncStepResult) => void)[]} */
    let currentStepCallbacks = [];

    /**
     * Pending invocation queued because its options conflicted with the
     * current run.  Last write wins for args; all callers that were queued
     * share the same promise.
     *
     * @type {{ args: [Capabilities, ({ resetToHostname?: string } | undefined), ((step: SyncStepResult) => void) | undefined], resolve: (v: void) => void, reject: (e: unknown) => void, promise: Promise<void> } | null}
     */
    let pendingInvocation = null;

    /**
     * @param {Capabilities} capabilities
     * @param {{ resetToHostname?: string } | undefined} options
     * @returns {Promise<void>}
     */
    function procedure(capabilities, options) {
        const fanOutStep = /** @param {SyncStepResult} step */ (step) => {
            for (const fn of currentStepCallbacks) fn(step);
        };
        return _synchronizeAllUnlocked(capabilities, options, fanOutStep);
    }

    const base = makeExclusiveProcess(procedure);

    /**
     * Starts a fresh run.  Records the options and first callback, then
     * registers a hook to drain `pendingInvocation` after the run ends.
     *
     * @param {Capabilities} capabilities
     * @param {{ resetToHostname?: string } | undefined} options
     * @param {((step: SyncStepResult) => void) | undefined} onStepComplete
     */
    function startRun(capabilities, options, onStepComplete) {
        currentRunOptions = options;
        currentStepCallbacks = onStepComplete ? [onStepComplete] : [];
        const handle = base.invoke([capabilities, options]);
        handle.result.then(
            () => { runPending(); },
            () => { runPending(); }
        );
        return handle;
    }

    /**
     * After the current run ends, starts the pending invocation (if any) and
     * wires its result to the pending callers' shared promise.
     */
    function runPending() {
        if (pendingInvocation === null) return;
        const { args, resolve, reject } = pendingInvocation;
        pendingInvocation = null;
        const [cap, opts, onStep] = args;
        const handle = startRun(cap, opts, onStep);
        handle.result.then(resolve, reject);
    }

    return {
        /**
         * Start or attach to (or queue behind) a synchronization run.
         *
         * @param {Capabilities} capabilities
         * @param {{ resetToHostname?: string }} [options]
         * @param {(step: SyncStepResult) => void} [onStepComplete]
         */
        invoke(capabilities, options, onStepComplete) {
            if (!base.isRunning()) {
                return startRun(capabilities, options, onStepComplete);
            }

            if (!_syncOptionsConflict(currentRunOptions, options)) {
                // Compatible options: attach and forward step callback.
                if (onStepComplete) currentStepCallbacks.push(onStepComplete);
                return base.invoke([capabilities, options]);
            }

            // Conflicting options: queue a run after the current one ends.
            if (pendingInvocation === null) {
                /** @type {(v: void) => void} */
                let resolve = (_v) => {};
                /** @type {(e: unknown) => void} */
                let reject = (_e) => {};
                const promise = /** @type {Promise<void>} */ (new Promise((res, rej) => {
                    resolve = res;
                    reject = rej;
                }));
                pendingInvocation = {
                    args: [capabilities, options, onStepComplete],
                    resolve,
                    reject,
                    promise,
                };
            } else {
                // Update args — last write wins; all queued callers share the same promise.
                pendingInvocation.args = [capabilities, options, onStepComplete];
            }
            return makeExclusiveProcessHandle(false, pendingInvocation.promise);
        },

        /**
         * Returns `true` if a synchronization run is currently active.
         * @returns {boolean}
         */
        isRunning() {
            return base.isRunning();
        },
    };
})();

/**
 * Synchronizes all destinations and then invalidates the incremental graph interface.
 *
 * All destinations are always attempted even if earlier ones fail (best-effort).
 * If any step fails it is wrapped in a dedicated typed error and collected.
 * A {@link SynchronizeAllError} containing all per-destination errors is thrown
 * at the end if at least one step failed; callers can inspect `.errors` and
 * dispatch on each type to produce per-destination log messages or responses.
 *
 * Uses a shared ExclusiveProcess singleton so that concurrent invocations with
 * compatible options attach to the running computation rather than starting a
 * new one.  Invocations with conflicting reset options are queued and run after
 * the current one completes.
 *
 * @param {Capabilities} capabilities
 * @param {{ resetToHostname?: string }} [options]
 * @param {(step: SyncStepResult) => void} [onStepComplete]
 * @returns {Promise<void>}
 * @throws {SynchronizeAllError}
 */
function synchronizeAll(capabilities, options, onStepComplete) {
    return synchronizeAllExclusiveProcess.invoke(capabilities, options, onStepComplete).result;
}

/**
 * Internal (unlocked) implementation of synchronizeAll.
 *
 * @param {Capabilities} capabilities
 * @param {{ resetToHostname?: string }} [options]
 * @param {(step: SyncStepResult) => void} [onStepComplete]
 * @returns {Promise<void>}
 */
async function _synchronizeAllUnlocked(capabilities, options, onStepComplete) {
    /** @type {SyncDestinationError[]} */
    const errors = [];

    await capabilities.interface.synchronizeDatabase(options).then(() => {
        onStepComplete?.({ name: "generators", status: "success" });
    }).catch((cause) => {
        errors.push(new GeneratorsSyncError(cause));
        onStepComplete?.({ name: "generators", status: "error" });
    });

    await assets.synchronize(capabilities).then(() => {
        onStepComplete?.({ name: "assets", status: "success" });
    }).catch((cause) => {
        errors.push(new AssetsSyncError(cause));
        onStepComplete?.({ name: "assets", status: "error" });
    });

    if (errors.length > 0) {
        throw new SynchronizeAllError(errors);
    }
}

module.exports = {
    synchronizeAll,
    synchronizeAllExclusiveProcess,
    isSynchronizeAllError,
    isAssetsSyncError,
    isGeneratorsSyncError,
};
