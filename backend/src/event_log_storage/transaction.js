/**
 * Implements transactional storage updates for event log entries and config.
 *
 * Call `transaction(transformation)` with a function that uses
 * `storage.addEntry(entry, assets)` to queue entries and assets and
 * `storage.setConfig(config)` to queue config updates. Event and config values
 * are persisted through the incremental graph; queued assets are copied after
 * the graph update succeeds.
 */

const path = require("path");
const event = require("../event");
const asset = event.asset;
const { targetPath } = asset;

/** @typedef {import("../event/id").EventId} EventId */
/** @typedef {import("../event").Event} Event */
/** @typedef {import("../event").Asset} Asset */
/** @typedef {import("../config/structure").Config} Config */
/** @typedef {import("../filesystem/creator").FileCreator} FileCreator */
/** @typedef {import("../filesystem/copier").FileCopier} FileCopier */
/** @typedef {import("../filesystem/deleter").FileDeleter} FileDeleter */
/** @typedef {import("../logger").Logger} Logger */
/** @typedef {import("../environment").Environment} Environment */
/** @typedef {import("../datetime").Datetime} Datetime */
/** @typedef {import("../generators").Interface} Interface */

/**
 * @typedef {object} EventLogStorageCapabilities
 * @property {FileCreator} creator
 * @property {FileCopier} copier
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
     * @param {Event} entry
     * @param {Array<Asset>} assets
     */
    addEntry(entry, assets) {
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
 * Error thrown when a requested entry deletion targets IDs that do not exist
 * in the event log.
 */
class EntryNotFoundError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "EntryNotFoundError";
    }
}

/**
 * @param {unknown} object
 * @returns {object is EntryNotFoundError}
 */
function isEntryNotFoundError(object) {
    return object instanceof EntryNotFoundError;
}

/**
 * @param {EventLogStorageCapabilities} capabilities
 * @param {Array<Asset>} assets
 * @returns {Promise<void>}
 */
async function copyAssets(capabilities, assets) {
    for (const asset of assets) {
        const destination = targetPath(capabilities, asset);
        await capabilities.creator.createDirectory(path.dirname(destination));
        await capabilities.copier.copyFile(asset.file, destination);
    }
}

/**
 * @param {EventLogStorageCapabilities} capabilities
 * @param {EventLogStorageClass} eventLogStorage
 * @returns {Promise<void>}
 */
async function cleanupAssets(capabilities, eventLogStorage) {
    for (const asset of eventLogStorage.getNewAssets()) {
        const assetPath = targetPath(capabilities, asset);
        try {
            await capabilities.deleter.deleteFile(assetPath);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            capabilities.logger.logWarning(
                {
                    file: assetPath,
                    error: msg,
                },
                `Failed to remove asset file ${assetPath}. This may be due to the file being in use or not existing.`
            );
        }
    }
}

/**
 * @template T
 * @typedef {(eventLogStorage: EventLogStorageClass) => Promise<T>} Transformation
 */

/**
 * Applies a transformation within an event log transaction.
 * @template T
 * @param {EventLogStorageCapabilities} capabilities
 * @param {Transformation<T>} transformation
 * @returns {Promise<T>}
 */
async function transaction(capabilities, transformation) {
    const eventLogStorage = new EventLogStorageClass(capabilities);
    try {
        const result = await transformation(eventLogStorage);
        const deletedIds = Array.from(eventLogStorage.getDeletedIds()).map(
            (id) => id.identifier
        );
        const existingEvents = await capabilities.interface.getAllEvents();
        const remainingEvents = existingEvents.filter(
            (entry) => !deletedIds.includes(entry.id.identifier)
        );
        const hasExistingDeletion = remainingEvents.length < existingEvents.length;
        const allDeletionsWereAbsorbed = deletedIds.every((id) =>
            eventLogStorage.getAbsorbedDeletionIds().has(id)
        );

        if (
            deletedIds.length > 0 &&
            !hasExistingDeletion &&
            !allDeletionsWereAbsorbed
        ) {
            throw new EntryNotFoundError(
                `Entry not found: ${deletedIds.join(", ")}`
            );
        }

        await copyAssets(capabilities, eventLogStorage.getNewAssets());

        const newConfig = eventLogStorage.getNewConfig();
        if (newConfig !== null) {
            await capabilities.interface.setConfig(newConfig);
        }

        if (deletedIds.length > 0 || eventLogStorage.getNewEntries().length > 0) {
            await capabilities.interface.update([
                ...remainingEvents,
                ...eventLogStorage.getNewEntries(),
            ]);
        }

        return result;
    } catch (error) {
        await cleanupAssets(capabilities, eventLogStorage);
        throw error;
    }
}

module.exports = { transaction, isEntryNotFoundError };
