const event = require("../event");
const { readObjects } = require("../json_stream_file");


/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../filesystem/copier').FileCopier} FileCopier */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../filesystem/appender').FileAppender} FileAppender */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/file').ExistingFile} ExistingFile */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */

/**
 * @typedef {object} Capabilities
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {FileCopier} copier - A file copier instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {FileAppender} appender - A file appender instance.
 * @property {FileCreator} creator - A directory creator instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {Command} git - A command instance for Git operations.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {import('../filesystem/reader').FileReader} reader - A file reader instance.
 */

/**
 * Minimal capabilities needed for appending entries to files
 * @typedef {object} AppendCapabilities
 * @property {FileAppender} appender - A file appender instance
 */

/**
 * Minimal capabilities needed for copying assets
 * @typedef {object} CopyAssetCapabilities
 * @property {FileCreator} creator - A file creator instance
 * @property {FileCopier} copier - A file copier instance
 * @property {Environment} environment - An environment instance (for targetPath)
 */

/**
 * Minimal capabilities needed for cleaning up assets
 * @typedef {object} CleanupAssetCapabilities
 * @property {FileDeleter} deleter - A file deleter instance
 * @property {Environment} environment - An environment instance (for targetPath)
 * @property {Logger} logger - A logger instance
 */

/**
 * Minimal capabilities needed for reading existing entries
 * @typedef {object} ReadEntriesCapabilities
 * @property {import('../filesystem/reader').FileReader} reader - A file reader instance
 * @property {Logger} logger - A logger instance
 */

/**
 * Comprehensive capabilities needed for EventLogStorage operations and transactions
 * @typedef {object} EventLogStorageCapabilities
 * @property {import('../filesystem/reader').FileReader} reader - A file reader instance
 * @property {FileWriter} writer - A file writer instance
 * @property {FileCreator} creator - A file creator instance
 * @property {FileChecker} checker - A file checker instance
 * @property {FileDeleter} deleter - A file deleter instance
 * @property {FileCopier} copier - A file copier instance
 * @property {FileAppender} appender - A file appender instance
 * @property {Command} git - A Git command instance
 * @property {Environment} environment - An environment instance
 * @property {Logger} logger - A logger instance
 */

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

/** @typedef {EventLogStorageClass} EventLogStorage */

module.exports = { EventLogStorageClass };
