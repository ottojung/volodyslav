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
 * Shared ExclusiveProcess for synchronization.
 *
 * Both the hourly scheduled job and the POST /sync route use this instance.
 * A second concurrent invocation attaches to the already-running computation
 * instead of starting a new one.
 */
const synchronizeAllExclusiveProcess = makeExclusiveProcess();

/**
 * Synchronizes all destinations and then invalidates the incremental graph interface.
 *
 * All destinations are always attempted even if earlier ones fail (best-effort).
 * If any step fails it is wrapped in a dedicated typed error and collected.
 * A {@link SynchronizeAllError} containing all per-destination errors is thrown
 * at the end if at least one step failed; callers can inspect `.errors` and
 * dispatch on each type to produce per-destination log messages or responses.
 *
 * Uses an ExclusiveProcess so that a second concurrent invocation attaches to
 * the already-running computation instead of starting a new one.  Any error
 * from the underlying sync propagates to all concurrent callers.
 *
 * @param {Capabilities} capabilities
 * @param {{ resetToHostname?: string }} [options]
 * @param {(step: SyncStepResult) => void} [onStepComplete]
 * @returns {Promise<void>}
 * @throws {SynchronizeAllError}
 */
function synchronizeAll(capabilities, options, onStepComplete) {
    const handle = synchronizeAllExclusiveProcess.invoke(() =>
        _synchronizeAllUnlocked(capabilities, options, onStepComplete)
    );
    return handle.result;
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
