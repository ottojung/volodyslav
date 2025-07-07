const event = require("../event");
const { readObjects } = require("../json_stream_file");


/** @typedef {import('./types').Capabilities} Capabilities */
/** @typedef {import('./types').AppendCapabilities} AppendCapabilities */
/** @typedef {import('./types').CopyAssetCapabilities} CopyAssetCapabilities */
/** @typedef {import('./types').CleanupAssetCapabilities} CleanupAssetCapabilities */
/** @typedef {import('./types').ReadEntriesCapabilities} ReadEntriesCapabilities */
/** @typedef {import('./types').EventLogStorageCapabilities} EventLogStorageCapabilities */
/** @typedef {import('./types').ExistingFile} ExistingFile */
/** @typedef {import('../event/id').EventId} EventId */

/**
 * A class to manage the storage of event log entries.
 *
 * Class to accumulate event entries before persisting.
 *
 * Intuitive Usage:
 * 1. Create an instance implicitly via `transaction()`.
 * 2. Call `addEntry()` once or multiple times to queue up events.
 * 3. `getNewEntries()` returns the queued array without side effects.
 *
 * Internal Note:
 * - `newEntries` is a simple in-memory array and does not interact with Git or the filesystem directly.
 */
class EventLogStorageClass {
    /**
     * Entries to be added to the event log.
     * @private
     * @type {Array<import('../event').Event>}
     */
    newEntries;

    /**
     * Assets to be added to the store.
     * @private
     * @type {Array<import('../event').Asset>}
     */
    newAssets;

    /**
     * Identifiers of entries queued for deletion.
     * @private
     * @type {Set<EventId>}
     */
    deletedIds;

    /**
     * Path to the data.json file, set during transaction
     * @type {ExistingFile|null}
     */
    dataFile = null;

    /**
     * Path to the config.json file, set during transaction
     * @type {ExistingFile|null|undefined}
     */
    configFile = undefined;

    /**
     * Cache for existing entries loaded from data.json
     * @private
     * @type {Array<import('../event/structure').Event>|null}
     */
    existingEntriesCache = null;

    /**
     * Cache for existing config loaded from config.json
     * @private
     * @type {import('../config/structure').Config|null}
     */
    existingConfigCache = null;

    /**
     * New config to be written to config.json
     * @private
     * @type {import('../config/structure').Config|null}
     */
    newConfig = null;

    /**
     * Capabilities object for file operations.
     * @type {Capabilities}
     */
    capabilities;

    /**
     * @constructor
     * Initializes an empty event log storage.
     * @param {EventLogStorageCapabilities} capabilities - The capabilities object for file operations.
     */
    constructor(capabilities) {
        this.capabilities = capabilities;
        this.newEntries = [];
        this.newAssets = [];
        this.deletedIds = new Set();
    }

    /**
     * Adds an entry to the event log.
     * @param {import('../event').Event} entry - The entry to add.
     * @param {import('../event/asset').Asset[]} assets - Possible assets related to the entry.
     */
    addEntry(entry, assets) {
        this.newEntries.push(entry);
        this.newAssets.push(...assets);
    }

    /**
     * Retrieves all new entries from the event log.
     * @returns {Array<import('../event').Event>} - The list of entries.
     */
    getNewEntries() {
        return this.newEntries;
    }

    /**
     * Retrieves all new assets from the repository.
     * @returns {Array<import('../event').Asset>} - The list of assets.
     */
    getNewAssets() {
        return this.newAssets;
    }

    /**
     * Marks an entry for deletion by its ID.
     * If the entry was queued in the same transaction, it will be removed.
     *
     * @param {import('../event/id').EventId} id - The identifier of the entry to delete.
     */
    deleteEntry(id) {
        this.deletedIds.add(id);
        this.newEntries = this.newEntries.filter(
            (e) => e.id.identifier !== id.identifier
        );
    }

    /**
     * Retrieves identifiers of entries queued for deletion.
     * @returns {Iterable<EventId>} - Iterator over identifiers to delete.
     */
    getDeletedIds() {
        return this.deletedIds.values();
    }

    /**
     * Sets a new configuration to be written to config.json
     * @param {import('../config/structure').Config} configObj - The config object to write
     */
    setConfig(configObj) {
        this.newConfig = configObj;
    }

    /**
     * Gets the new configuration to be written
     * @returns {import('../config/structure').Config|null} - The config object or null if none set
     */
    getNewConfig() {
        return this.newConfig;
    }

    /**
     * Lazily reads and returns the config that existed in config.json
     * at the start of the current transaction. The file is only read
     * on the first call, subsequent calls return cached results.
     *
     * Uses capabilities: reader, logger (via configStorage.readConfig)
     *
     * @returns {Promise<import('../config/structure').Config|null>} - The existing config or null if not found/invalid
     * @throws {Error} - If called outside of a transaction.
     */
    async getExistingConfig() {
        if (this.configFile === undefined) {
            throw new Error(
                "getExistingConfig() called outside of a transaction"
            );
        }

        // Return cached results if available
        if (this.existingConfigCache !== null) {
            return this.existingConfigCache;
        }

        // If config file doesn't exist, return null
        if (this.configFile === null) {
            this.existingConfigCache = null;
            return null;
        }

        try {
            const configStorage = require("../config/storage");
            const config = require("../config");

            const configResult = await configStorage.readConfig(
                this.capabilities,
                this.configFile
            );

            // If readConfig returned an error object, it means the config is invalid
            if (config.isTryDeserializeError(configResult)) {
                this.capabilities.logger.logWarning(
                    {
                        filepath: this.configFile,
                        error: configResult.message,
                        field: configResult.field,
                        value: configResult.value,
                        expectedType: configResult.expectedType,
                        errorType: configResult.name
                    },
                    "Found invalid config object in file"
                );
                this.existingConfigCache = null;
                return null;
            }

            if (configResult instanceof Error) {
                this.existingConfigCache = null;
                return null;
            }

            this.existingConfigCache = configResult;
            return this.existingConfigCache;
        } catch (error) {
            this.existingConfigCache = null;
            return this.existingConfigCache;
        }
    }

    /**
     * Lazily reads and returns the events that existed in data.json
     * at the start of the current transaction. The file is only read
     * on the first call, subsequent calls return cached results.
     *
     * Uses capabilities: reader, logger (via readObjects)
     *
     * @returns {Promise<Array<import('../event/structure').Event>>} - The list of existing entries from data.json.
     * @throws {Error} - If called outside of a transaction.
     */
    async getExistingEntries() {
        if (!this.dataFile) {
            throw new Error(
                "getExistingEntries() called outside of a transaction"
            );
        }

        // Return cached results if available
        if (this.existingEntriesCache !== null) {
            return this.existingEntriesCache;
        }

        try {
            const objects = await readObjects(this.capabilities, this.dataFile);

            // Use tryDeserialize to safely convert objects to Events
            /** @type {Array<import('../event/structure').Event>} */
            const validEvents = [];

            for (const obj of objects) {
                const result = event.tryDeserialize(obj);
                if (event.isTryDeserializeError(result)) {
                    this.capabilities.logger.logWarning(
                        {
                            invalidObject: obj,
                            error: result.message,
                            field: result.field,
                            value: result.value,
                            expectedType: result.expectedType,
                            errorType: result.name
                        },
                        "Found invalid object in data.json, skipping"
                    );
                } else {
                    validEvents.push(result);
                }
            }

            this.existingEntriesCache = validEvents;
            return this.existingEntriesCache;
        } catch (error) {
            this.existingEntriesCache = [];
            return this.existingEntriesCache;
        }
    }
}

/** @typedef {InstanceType<typeof EventLogStorageClass>} EventLogStorage */

/**
 * Factory to create an EventLogStorage instance.
 * @param {EventLogStorageCapabilities} capabilities - The capabilities object.
 * @returns {EventLogStorage}
 */
function make(capabilities) {
    return new EventLogStorageClass(capabilities);
}

/**
 * Type guard for EventLogStorage instances.
 * @param {unknown} object
 * @returns {object is EventLogStorage}
 */
function isEventLogStorage(object) {
    return object instanceof EventLogStorageClass;
}

module.exports = {
    make,
    isEventLogStorage,
};
