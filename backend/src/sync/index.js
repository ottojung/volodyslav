const eventLogStorage = require("../event_log_storage");
const assets = require("../assets");
const { synchronizeDatabase } = require("../generators");

/** @typedef {import('../gitstore/working_repository').SyncForce} SyncForce */
/** @typedef {import('../capabilities/root').Capabilities} Capabilities */

// ---------------------------------------------------------------------------
// Per-destination error types
// ---------------------------------------------------------------------------

class EventLogSyncError extends Error {
    /** @param {unknown} cause */
    constructor(cause) {
        super(`Event log sync failed: ${cause}`);
        this.name = "EventLogSyncError";
        this.cause = cause;
    }
}

/** @param {unknown} object @returns {object is EventLogSyncError} */
function isEventLogSyncError(object) {
    return object instanceof EventLogSyncError;
}

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

class InterfaceUpdateError extends Error {
    /** @param {unknown} cause */
    constructor(cause) {
        super(`Interface update failed: ${cause}`);
        this.name = "InterfaceUpdateError";
        this.cause = cause;
    }
}

/** @param {unknown} object @returns {object is InterfaceUpdateError} */
function isInterfaceUpdateError(object) {
    return object instanceof InterfaceUpdateError;
}

// ---------------------------------------------------------------------------
// Aggregate error
// ---------------------------------------------------------------------------

/**
 * @typedef {EventLogSyncError | AssetsSyncError | GeneratorsSyncError | InterfaceUpdateError} SyncDestinationError
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
 * Synchronizes all destinations (event log, assets, generators database) and
 * then invalidates the incremental graph interface.
 *
 * All destinations are always attempted even if earlier ones fail (best-effort).
 * If any step fails it is wrapped in a dedicated typed error and collected.
 * A {@link SynchronizeAllError} containing all per-destination errors is thrown
 * at the end if at least one step failed; callers can inspect `.errors` and
 * dispatch on each type to produce per-destination log messages or responses.
 *
 * @param {Capabilities} capabilities
 * @param {{ force?: SyncForce }} [options]
 * @returns {Promise<void>}
 * @throws {SynchronizeAllError}
 */
async function synchronizeAll(capabilities, options) {
    /** @type {SyncDestinationError[]} */
    const errors = [];

    await eventLogStorage.synchronize(capabilities, options).catch((cause) => {
        errors.push(new EventLogSyncError(cause));
    });

    await assets.synchronize(capabilities).catch((cause) => {
        errors.push(new AssetsSyncError(cause));
    });

    await synchronizeDatabase(capabilities, options).catch((cause) => {
        errors.push(new GeneratorsSyncError(cause));
    });

    await capabilities.interface.update().catch((cause) => {
        errors.push(new InterfaceUpdateError(cause));
    });

    if (errors.length > 0) {
        throw new SynchronizeAllError(errors);
    }
}

module.exports = {
    synchronizeAll,
    isSynchronizeAllError,
    isEventLogSyncError,
    isAssetsSyncError,
    isGeneratorsSyncError,
    isInterfaceUpdateError,
};
