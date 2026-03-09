const event = require("../event");
const { readObjects } = require("../json_stream_file");
const {
    ExistingConfigReadError,
    ExistingEntriesReadError,
} = require("./read_errors");
/** @typedef {import('./types').Capabilities} Capabilities */
/** @typedef {import('./types').AppendCapabilities} AppendCapabilities */
/** @typedef {import('./types').CopyAssetCapabilities} CopyAssetCapabilities */
/** @typedef {import('./types').CleanupAssetCapabilities} CleanupAssetCapabilities */
/** @typedef {import('./types').ReadEntriesCapabilities} ReadEntriesCapabilities */
/** @typedef {import('./types').EventLogStorageCapabilities} EventLogStorageCapabilities */
/** @typedef {import('./types').ExistingFile} ExistingFile */
/** @typedef {import('../event/id').EventId} EventId */

/**
 * A class to accumulate event log entries before persisting them.
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
     * Identifiers of entries that were queued in this transaction and then
     * deleted via deleteEntry() — i.e. absorbed before they were ever committed.
     * @private
     * @type {Set<string>}
     */
    absorbedDeletionIds;

    /**
     * Path to the data.json file, set during transaction.
     * Undefined means no transaction has initialized this storage yet;
     * null means the transaction is active but data.json does not exist.
     * @type {ExistingFile|null|undefined}
     */
    dataFile = undefined;

    /**
     * Path to the config.json file, set during transaction
     * @type {ExistingFile|null|undefined}
     */
    configFile = undefined;

    /**
     * Cache for existing entries loaded from data.json
     * @private
     * @type {Array<import('../event/structure').Event>}
     */
    existingEntriesCache = [];

    /**
     * Tracks whether existing entries have already been loaded during the
     * current transaction.
     * @private
     * @type {boolean}
     */
    hasExistingEntriesCache = false;

    /**
     * Cache for existing config loaded from config.json
     * @private
     * @type {import('../config/structure').Config|null}
     */
    existingConfigCache = null;

    /**
     * Tracks whether existing config has already been loaded during the
     * current transaction.
     * @private
     * @type {boolean}
     */
    hasExistingConfigCache = false;

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
        this.absorbedDeletionIds = new Set();
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
     * If the entry was queued in the same transaction, it will be removed
     * immediately (absorbed) and not committed.
     *
     * @param {import('../event/id').EventId} id - The identifier of the entry to delete.
     */
    deleteEntry(id) {
        this.deletedIds.add(id);
        const before = this.newEntries.length;
        this.newEntries = this.newEntries.filter(
            (e) => e.id.identifier !== id.identifier
        );
        if (this.newEntries.length < before) {
            this.absorbedDeletionIds.add(id.identifier);
        }
    }

    /**
     * Retrieves identifiers of entries queued for deletion.
     * @returns {Iterable<EventId>} - Iterator over identifiers to delete.
     */
    getDeletedIds() {
        return this.deletedIds.values();
    }

    /**
     * Retrieves the set of entry identifier strings that were absorbed
     * (i.e. the entry was added and deleted within the same transaction).
     * @returns {Set<string>}
     */
    getAbsorbedDeletionIds() {
        return this.absorbedDeletionIds;
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
        if (this.hasExistingConfigCache) {
            return this.existingConfigCache;
        }

        // If config file doesn't exist, return null
        if (this.configFile === null) {
            this.existingConfigCache = null;
            this.hasExistingConfigCache = true;
            return null;
        }

        try {
            const config = require("../config");
            const configStorage = config.storage;

            const configResult = await configStorage.readConfig(
                this.capabilities,
                this.configFile
            );

            // If readConfig returned an error object, it means the config is invalid
            if (config.isTryDeserializeError(configResult)) {
                this.capabilities.logger.logWarning(
                    {
                        filepath: this.configFile.path,
                        error: configResult.message,
                        field: configResult.field,
                        value: configResult.value,
                        expectedType: configResult.expectedType,
                        errorType: configResult.name,
                    },
                    "Found invalid config object in file"
                );
                this.existingConfigCache = null;
                this.hasExistingConfigCache = true;
                return null;
            }

            if (configResult instanceof Error) {
                throw new ExistingConfigReadError(
                    this.configFile.path,
                    configResult
                );
            }

            this.existingConfigCache = configResult;
            this.hasExistingConfigCache = true;
            return this.existingConfigCache;
        } catch (error) {
            const readError = error instanceof ExistingConfigReadError
                ? error
                : new ExistingConfigReadError(this.configFile.path, error);
            this.capabilities.logger.logError(
                {
                    filepath: this.configFile.path,
                    error: readError.message,
                },
                "Failed to read config.json"
            );
            throw readError;
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
        if (this.dataFile === undefined) {
            throw new Error(
                "getExistingEntries() called outside of a transaction"
            );
        }

        // Return cached results if available
        if (this.hasExistingEntriesCache) {
            return this.existingEntriesCache;
        }

        if (this.dataFile === null) {
            this.existingEntriesCache = [];
            this.hasExistingEntriesCache = true;
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
                            filepath: this.dataFile.path,
                            invalidObject: obj,
                            error: result.message,
                            field: result.field,
                            value: result.value,
                            expectedType: result.expectedType,
                            errorType: result.name,
                        },
                        "Found invalid object in data.json, skipping"
                    );
                } else {
                    validEvents.push(result);
                }
            }

            this.existingEntriesCache = validEvents;
            this.hasExistingEntriesCache = true;
            return this.existingEntriesCache;
        } catch (error) {
            const readError = error instanceof ExistingEntriesReadError
                ? error
                : new ExistingEntriesReadError(this.dataFile.path, error);
            this.capabilities.logger.logError(
                {
                    filepath: this.dataFile.path,
                    error: readError.message,
                },
                "Failed to read data.json"
            );
            throw readError;
        }
    }
}

/** @typedef {EventLogStorageClass} EventLogStorage */

/**
 * Creates a new EventLogStorage instance.
 * @param {EventLogStorageCapabilities} capabilities
 * @returns {EventLogStorage}
 */
function make(capabilities) {
    return new EventLogStorageClass(capabilities);
}

/**
 * Type guard for EventLogStorage.
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
