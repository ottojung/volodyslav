const { tryValidateEvent } = require("../event");

/** @typedef {import("../event/errors").TryDeserializeError} TryDeserializeError */

/** @typedef {import("../event/id").EventId} EventId */
/** @typedef {import("../event").Event} Event */
/** @typedef {import("../event").Asset} Asset */
/** @typedef {import("../config/structure").Config} Config */
/** @typedef {import("../filesystem/creator").FileCreator} FileCreator */
/** @typedef {import("../filesystem/writer").FileWriter} FileWriter */
/** @typedef {import("../filesystem/deleter").FileDeleter} FileDeleter */
/** @typedef {import("../logger").Logger} Logger */
/** @typedef {import("../environment").Environment} Environment */
/** @typedef {import("../datetime").Datetime} Datetime */
/** @typedef {import("../generators").Interface} Interface */

/**
 * @typedef {object} EventLogStorageCapabilities
 * @property {FileCreator} creator
 * @property {FileWriter} writer
 * @property {FileDeleter} deleter
 * @property {Logger} logger
 * @property {Environment} environment
 * @property {Datetime} datetime
 * @property {Interface} interface
 */

/**
 * A class to accumulate event log entries before persisting them.
 */
class EventLogStorageClass {
    /** @type {Array<Event>} */
    newEntries = [];

    /** @type {Array<Asset>} */
    newAssets = [];

    /** @type {Array<EventId>} */
    deletedIds = [];

    /** @type {Set<string>} */
    absorbedDeletionIds = new Set();

    /** @type {Config | null} */
    existingConfigCache = null;

    /** @type {boolean} */
    hasExistingConfigCache = false;

    /** @type {Config | null} */
    newConfig = null;

    /**
     * @param {EventLogStorageCapabilities} capabilities
     */
    constructor(capabilities) {
        this.capabilities = capabilities;
    }

    /**
     * Queue an event and its assets for the graph update this transaction ends with.
     *
     * The entry is validated here, at the boundary where a producer's event enters
     * the log, rather than at the Journal record layer which later serializes it:
     * an event missing `original` or `input` is not an event, and persisting it
     * would make the graph's `all_events` value a payload no current-version
     * computed value can represent.
     *
     * @param {Event} entry
     * @param {Array<Asset>} assets
     * @throws {IncompleteEventError} If the entry is not a complete event.
     */
    addEntry(entry, assets) {
        const problem = tryValidateEvent(entry);
        if (problem !== undefined) {
            throw new IncompleteEventError(problem);
        }
        this.newEntries.push(entry);
        this.newAssets.push(...assets);
    }

    /**
     * @returns {Array<Event>}
     */
    getNewEntries() {
        return this.newEntries;
    }

    /**
     * @returns {Array<Asset>}
     */
    getNewAssets() {
        return this.newAssets;
    }

    /**
     * @param {EventId} id
     */
    deleteEntry(id) {
        const index = this.newEntries.findIndex(
            (entry) => entry.id.identifier === id.identifier
        );
        if (index !== -1) {
            this.newEntries.splice(index, 1);
            this.absorbedDeletionIds.add(id.identifier);
            return;
        }
        this.deletedIds.push(id);
    }

    /**
     * @returns {Iterable<EventId>}
     */
    getDeletedIds() {
        return this.deletedIds;
    }

    /**
     * @returns {Set<string>}
     */
    getAbsorbedDeletionIds() {
        return this.absorbedDeletionIds;
    }

    /**
     * @param {Config} config
     */
    setConfig(config) {
        this.newConfig = config;
    }

    /**
     * @returns {Config | null}
     */
    getNewConfig() {
        return this.newConfig;
    }

    /**
     * @returns {Promise<Config | null>}
     */
    async getExistingConfig() {
        if (this.hasExistingConfigCache) {
            return this.existingConfigCache;
        }
        this.existingConfigCache = await this.capabilities.interface.getConfig();
        this.hasExistingConfigCache = true;
        return this.existingConfigCache;
    }
}

/**
 * Thrown when a producer queues an entry which is not a complete event.
 *
 * The offending field is carried as the cause's own `field`, so the caller reports
 * which part of the event was missing rather than that some event was.
 */
class IncompleteEventError extends Error {
    /**
     * @param {TryDeserializeError} cause
     */
    constructor(cause) {
        super(`Event log entry is not a complete event: ${cause.message}`);
        this.name = "IncompleteEventError";
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is IncompleteEventError}
 */
function isIncompleteEventError(object) {
    return object instanceof IncompleteEventError;
}

/** @typedef {InstanceType<typeof EventLogStorageClass>} EventLogStorage */

/**
 * @param {EventLogStorageCapabilities} capabilities
 * @returns {EventLogStorage}
 */
function make(capabilities) {
    return new EventLogStorageClass(capabilities);
}

/**
 * @param {unknown} object
 * @returns {object is EventLogStorage}
 */
function isEventLogStorage(object) {
    return object instanceof EventLogStorageClass;
}

module.exports = {
    make,
    isEventLogStorage,
    IncompleteEventError,
    isIncompleteEventError,
};
