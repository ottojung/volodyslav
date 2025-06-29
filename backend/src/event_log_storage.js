/**
 * Implements atomic, Git-based storage for event log entries and their assets.
 *
 * Call `transaction(transformation)` with a function that uses
 * `storage.addEntry(entry, assets)` to queue log entries and assets. The
 * process appends entries to `data.json` and writes any config changes.
 * If there are new entries or config, those changes are committed before
 * any assets are copied into the repository.
 * If any step fails, copied assets are removed before the error is rethrown.
 */

const path = require("path");
const gitstore = require("./gitstore");
const event = require("./event");
const { readObjects } = require("./json_stream_file");
const { targetPath } = require("./event/asset");
const configStorage = require("./config/storage");

/** @typedef {import('./filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('./filesystem/copier').FileCopier} FileCopier */
/** @typedef {import('./filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('./filesystem/appender').FileAppender} FileAppender */
/** @typedef {import('./filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('./filesystem/file').ExistingFile} ExistingFile */
/** @typedef {import('./filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('./subprocess/command').Command} Command */
/** @typedef {import('./environment').Environment} Environment */
/** @typedef {import('./logger').Logger} Logger */

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
 * @property {import('./filesystem/reader').FileReader} reader - A file reader instance.
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
 * @property {import('./filesystem/reader').FileReader} reader - A file reader instance
 * @property {Logger} logger - A logger instance
 */

/**
 * Comprehensive capabilities needed for EventLogStorage operations and transactions
 * @typedef {object} EventLogStorageCapabilities
 * @property {import('./filesystem/reader').FileReader} reader - A file reader instance
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
     * @type {Array<import('./event').Event>}
     */
    newEntries;

    /**
     * Assets to be added to the store.
     * @private
     * @type {Array<import('./event').Asset>}
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
     * @type {Array<import('./event/structure').Event>|null}
     */
    existingEntriesCache = null;

    /**
     * Cache for existing config loaded from config.json
     * @private
     * @type {import('./config/structure').Config|null}
     */
    existingConfigCache = null;

    /**
     * New config to be written to config.json
     * @private
     * @type {import('./config/structure').Config|null}
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
     * @param {import('./event').Event} entry - The entry to add.
     * @param {import('./event/asset').Asset[]} assets - Possible assets related to the entry.
     */
    addEntry(entry, assets) {
        this.newEntries.push(entry);
        this.newAssets.push(...assets);
    }

    /**
     * Retrieves all new entries from the event log.
     * @returns {Array<import('./event').Event>} - The list of entries.
     */
    getNewEntries() {
        return this.newEntries;
    }

    /**
     * Retrieves all new assets from the repository.
     * @returns {Array<import('./event').Asset>} - The list of assets.
     */
    getNewAssets() {
        return this.newAssets;
    }

    /**
     * Sets a new configuration to be written to config.json
     * @param {import('./config/structure').Config} configObj - The config object to write
     */
    setConfig(configObj) {
        this.newConfig = configObj;
    }

    /**
     * Gets the new configuration to be written
     * @returns {import('./config/structure').Config|null} - The config object or null if none set
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
     * @returns {Promise<import('./config/structure').Config|null>} - The existing config or null if not found/invalid
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
            const configStorage = require("./config/storage");
            const config = require("./config");

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

            this.existingConfigCache = /** @type {import('./config/structure').Config} */ (configResult);
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
     * @returns {Promise<Array<import('./event/structure').Event>>} - The list of existing entries from data.json.
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
            /** @type {Array<import('./event/structure').Event>} */
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

/**
 * Appends an array of entries to a specified file.
 * Each entry is serialized to JSON format and appended to the file with a newline.
 *
 * @param {AppendCapabilities} capabilities - The minimal capabilities needed for appending entries
 * @param {ExistingFile} file - The file where entries will be appended.
 * @param {Array<import('./event').Event>} entries - An array of objects to append to the file.
 * @returns {Promise<void>} - A promise that resolves when all entries are appended.
 *
 * Notes and Gotchas:
 * - Uses `JSON.stringify(entry, null, "\t")` to pretty-print with tabs. This produces multi-line JSON.
 *   Consumers must parse complex blocks rather than line-by-line JSON.
 * - Each `appendFile` call opens and closes the file; for high-volume writes, batching or streaming may be more efficient.
 */
async function appendEntriesToFile(capabilities, file, entries) {
    for (const entry of entries) {
        const serialized = event.serialize(entry);
        const eventString = JSON.stringify(serialized, null, "\t");
        await capabilities.appender.appendFile(file, eventString + "\n");
    }
}

/**
 * New helper to copy all queued assets into the asset directory.
 * Ensures that the parent directory exists before copying files.
 * @param {CopyAssetCapabilities} capabilities - The minimal capabilities needed for copying assets
 * @param {import('./event').Asset[]} assets - An array of assets to copy.
 * @returns {Promise<void>} - A promise that resolves when all assets are copied.
 */
async function copyAssets(capabilities, assets) {
    for (const asset of assets) {
        const target = targetPath(capabilities, asset);
        const targetDir = path.dirname(target);
        await capabilities.creator.createDirectory(targetDir);
        await capabilities.copier.copyFile(asset.file, target);
    }
}

/**
 * @template T
 * @typedef {(eventLogStorage: EventLogStorage) => Promise<T>} Transformation
 */

/**
 * Performs a Git-backed transaction using the given storage and transformation.
 * @template T
 * @param {EventLogStorageCapabilities} capabilities - An object containing the capabilities.
 * @param {EventLogStorage} eventLogStorage - The event log storage instance.
 * @param {Transformation<T>} transformation - Async callback to apply to the storage.
 * @returns {Promise<T>}
 */
async function performGitTransaction(
    capabilities,
    eventLogStorage,
    transformation
) {
    return await gitstore.transaction(capabilities, async (store) => {
        const workTree = await store.getWorkTree();
        const dataPath = path.join(workTree, "data.json");
        const configPath = path.join(workTree, "config.json");
        const dataFile = await capabilities.checker
            .instantiate(dataPath)
            .catch(() => null);
        const configFile = await capabilities.checker
            .instantiate(configPath)
            .catch(() => null);

        // Set file paths for possible lazy loading
        eventLogStorage.dataFile = dataFile;
        eventLogStorage.configFile = configFile;

        // Run user-provided transformation to accumulate entries and config
        const result = await transformation(eventLogStorage);

        // Get the new entries to persist
        const newEntries = eventLogStorage.getNewEntries();
        const newConfig = eventLogStorage.getNewConfig();

        // Track if we need to commit
        let needsCommit = false;

        // Persist and commit when we have new entries or configuration changes
        if (newEntries.length > 0) {
            // Persist queued entries
            const existingDataFile = dataFile == null ? await capabilities.creator.createFile(dataPath) : dataFile;
            await appendEntriesToFile(capabilities, existingDataFile, newEntries);
            needsCommit = true;
        }

        // Write config if changed
        if (newConfig !== null) {
            await configStorage.writeConfig(
                capabilities,
                configPath,
                newConfig
            );
            needsCommit = true;
        }

        // Commit queued changes if needed
        if (needsCommit) {
            await store.commit("Event log storage update");
        }

        // Copy any queued assets
        const assets = eventLogStorage.getNewAssets();
        await copyAssets(capabilities, assets);

        return result;
    });
}

/**
 * Cleans up all copied assets by removing their files.
 * @param {CleanupAssetCapabilities} capabilities - The minimal capabilities needed for cleaning up assets
 * @param {EventLogStorage} eventLogStorage - The storage containing asset references.
 * @returns {Promise<void>}
 */
async function cleanupAssets(capabilities, eventLogStorage) {
    const assets = eventLogStorage.getNewAssets();
    for (const asset of assets) {
        // determine path of copied asset and attempt removal
        const assetPath = targetPath(capabilities, asset);
        try {
            await capabilities.deleter.deleteFile(assetPath);
        } catch (error) {
            const msg =
                error instanceof Error ? error.message : String(error);
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
 * Applies a transformation within a Git-backed event log transaction.
 * @template T
 * @param {EventLogStorageCapabilities} capabilities - An object containing the capabilities.
 * @param {Transformation<T>} transformation - The transformation to execute.
 * @returns {Promise<T>}
 */
async function transaction(capabilities, transformation) {
    const eventLogStorage = new EventLogStorageClass(capabilities);
    try {
        return await performGitTransaction(
            capabilities,
            eventLogStorage,
            transformation
        );
    } catch (error) {
        // If anything goes wrong, clean up all copied assets and rethrow.
        await cleanupAssets(capabilities, eventLogStorage);
        throw error;
    }
}

module.exports = { transaction };
