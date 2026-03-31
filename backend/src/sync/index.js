const assets = require("../assets");
const { makeExclusiveProcess } = require("../exclusive_process");
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
 * Captured capabilities for the current / most-recent sync run.
 * Set by `synchronizeAll` before each `invoke` so the fixed procedure can
 * reference it without receiving it as an `invoke` arg.
 * @type {Capabilities | null}
 */
let _syncCapabilities = null;

/**
 * Per-run fan-out list of step callbacks.  Populated on each new run
 * (initiator) and extended by the `onAttach` hook when further callers join.
 * @type {((step: SyncStepResult) => void)[]}
 */
let _activeSyncStepCallbacks = [];

/**
 * Shared ExclusiveProcess for synchronization.
 *
 * Both the hourly scheduled job and the POST /sync route use this instance.
 *
 * `invoke` receives `[options, onStepComplete]` (the parametric arguments).
 * `capabilities` is a non-parametric dependency captured via the module-level
 * `_syncCapabilities` variable, updated by `synchronizeAll` before each call.
 *
 * Behaviour when a second call arrives while a run is active:
 * - **Compatible options** (same `resetToHostname` or none) → attach; the
 *   attacher's `onStepComplete` is added to the fan-out list.
 * - **Conflicting options** (wants a reset the current run isn't doing) →
 *   queue: after the current run ends, a fresh run starts with the queued
 *   args; last-write-wins when multiple conflicting calls queue up.
 */
const synchronizeAllExclusiveProcess = makeExclusiveProcess(
    /**
     * @param {{ resetToHostname?: string } | undefined} options
     * @param {((step: SyncStepResult) => void) | undefined} onStepComplete
     * @returns {Promise<void>}
     */
    (options, onStepComplete) => {
        // Reset the fan-out list for this run.
        _activeSyncStepCallbacks = onStepComplete ? [onStepComplete] : [];
        const fanOut = /** @param {SyncStepResult} step */ (step) => {
            for (const fn of _activeSyncStepCallbacks) fn(step);
        };
        return _synchronizeAllUnlocked(
            /** @type {Capabilities} */ (_syncCapabilities),
            options,
            fanOut
        );
    },
    {
        onAttach: (newArgs) => {
            const onStepComplete = /** @type {((step: SyncStepResult) => void) | undefined} */ (newArgs[1]);
            if (onStepComplete) _activeSyncStepCallbacks.push(onStepComplete);
        },
        shouldQueue: (currentArgs, newArgs) => {
            const currentOptions = /** @type {{ resetToHostname?: string } | undefined} */ (currentArgs[0]);
            const newOptions = /** @type {{ resetToHostname?: string } | undefined} */ (newArgs[0]);
            return _syncOptionsConflict(currentOptions, newOptions);
        },
    }
);

/**
 * Synchronizes all destinations and then invalidates the incremental graph interface.
 *
 * All destinations are always attempted even if earlier ones fail (best-effort).
 * If any step fails it is wrapped in a dedicated typed error and collected.
 * A {@link SynchronizeAllError} containing all per-destination errors is thrown
 * at the end if at least one step failed; callers can inspect `.errors` and
 * dispatch on each type to produce per-destination log messages or responses.
 *
 * Uses a shared ExclusiveProcess so that concurrent invocations with compatible
 * options attach to the running computation rather than starting a new one.
 * Invocations with conflicting reset options are queued and run after the
 * current one completes.
 *
 * @param {Capabilities} capabilities
 * @param {{ resetToHostname?: string }} [options]
 * @param {(step: SyncStepResult) => void} [onStepComplete]
 * @returns {Promise<void>}
 * @throws {SynchronizeAllError}
 */
function synchronizeAll(capabilities, options, onStepComplete) {
    _syncCapabilities = capabilities;
    return synchronizeAllExclusiveProcess.invoke([options, onStepComplete]).result;
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
