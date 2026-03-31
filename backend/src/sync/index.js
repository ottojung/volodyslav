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
 * Returns `"queue"` if the incoming options conflict with the current run's
 * options.  A conflict occurs when the new caller wants to reset to a specific
 * hostname that differs from what the current run is doing (either the current
 * run has no reset, or is resetting to a different hostname).
 *
 * If the new caller has no reset requirement (`resetToHostname` is absent),
 * any ongoing run is acceptable and the new call attaches.
 *
 * @param {{ capabilities: Capabilities, options?: { resetToHostname?: string } }} initiating
 * @param {{ capabilities: Capabilities, options?: { resetToHostname?: string } }} attaching
 * @returns {"attach" | "queue"}
 */
function _syncConflictor(initiating, attaching) {
    const incomingReset = attaching.options?.resetToHostname;
    if (incomingReset === undefined) return "attach";
    return incomingReset !== initiating.options?.resetToHostname ? "queue" : "attach";
}

/**
 * Argument type for `synchronizeAllExclusiveProcess`.
 * `capabilities` is part of the argument so the procedure can use it directly.
 *
 * @typedef {{ capabilities: Capabilities, options?: { resetToHostname?: string } }} SyncArg
 */

/**
 * Shared ExclusiveProcess for synchronization.
 *
 * Both the hourly scheduled job and the POST /sync route use this instance.
 *
 * The procedure receives `fanOut` (the class-managed fan-out callback, used
 * as `onStepComplete`) and `{ capabilities, options }` directly.
 *
 * Behaviour when a second call arrives while a run is active:
 * - **Compatible options** (same `resetToHostname` or none) → attaches; the
 *   attacher's `onStepComplete` is registered in the native fan-out.
 * - **Conflicting options** (wants a reset the current run isn't doing) →
 *   queued: after the current run ends a fresh run starts with the queued
 *   options; last-write-wins when multiple conflicting calls queue up, but
 *   all queued callers' callbacks are composed so everyone receives events.
 */
const synchronizeAllExclusiveProcess = makeExclusiveProcess({
    /**
     * @param {(step: SyncStepResult) => void} fanOut
     * @param {SyncArg} arg
     * @returns {Promise<void>}
     */
    procedure: (fanOut, { capabilities, options }) => {
        return _synchronizeAllUnlocked(capabilities, options, fanOut);
    },
    conflictor: _syncConflictor,
});

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
    return synchronizeAllExclusiveProcess.invoke({ capabilities, options }, onStepComplete).result;
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
