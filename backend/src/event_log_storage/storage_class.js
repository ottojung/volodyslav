/**
 * Implements atomic, Git-based storage for event log entries and their assets.
 *
 * This module defines {@link EventLogStorageClass} used within transactions.
 */

const event = require("../event");
const { readObjects } = require("../json_stream_file");
const configStorage = require("../config/storage");

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
/** @typedef {import('../filesystem/reader').FileReader} FileReader */

/**
 * @typedef {object} Capabilities
 * @property {FileDeleter} deleter
 * @property {FileCopier} copier
 * @property {FileWriter} writer
 * @property {FileAppender} appender
 * @property {FileCreator} creator
 * @property {FileChecker} checker
 * @property {Command} git
 * @property {Environment} environment
 * @property {Logger} logger
 * @property {FileReader} reader
 */

/**
 * Comprehensive capabilities needed for EventLogStorage operations and transactions.
 * @typedef {object} EventLogStorageCapabilities
 * @property {FileReader} reader
 * @property {FileWriter} writer
 * @property {FileCreator} creator
 * @property {FileChecker} checker
 * @property {FileDeleter} deleter
 * @property {FileCopier} copier
 * @property {FileAppender} appender
 * @property {Command} git
 * @property {Environment} environment
 * @property {Logger} logger
 */

/**
 * A class to manage the storage of event log entries.
 */
class EventLogStorageClass {
    /** @type {Array<import('../event').Event>} */
    newEntries;
    /** @type {Array<import('../event').Asset>} */
    newAssets;

    /** @type {ExistingFile|null} */
    dataFile = null;
    /** @type {ExistingFile|null|undefined} */
    configFile = undefined;

    /** @type {Array<import('../event/structure').Event>|null} */
    existingEntriesCache = null;
    /** @type {import('../config/structure').Config|null} */
    existingConfigCache = null;
    /** @type {import('../config/structure').Config|null} */
    newConfig = null;

    /** @type {Capabilities} */
    capabilities;

    /**
     * Initializes an empty event log storage.
     * @param {EventLogStorageCapabilities} capabilities
     */
    constructor(capabilities) {
        this.capabilities = capabilities;
        this.newEntries = [];
        this.newAssets = [];
    }

    /**
     * Add an entry to the event log.
     * @param {import('../event').Event} entry
     * @param {import('../event/asset').Asset[]} assets
     */
    addEntry(entry, assets) {
        this.newEntries.push(entry);
        this.newAssets.push(...assets);
    }

    /**
     * @returns {Array<import('../event').Event>}
     */
    getNewEntries() {
        return this.newEntries;
    }

    /**
     * @returns {Array<import('../event').Asset>}
     */
    getNewAssets() {
        return this.newAssets;
    }

    /**
     * @param {import('../config/structure').Config} configObj
     */
    setConfig(configObj) {
        this.newConfig = configObj;
    }

    /**
     * @returns {import('../config/structure').Config|null}
     */
    getNewConfig() {
        return this.newConfig;
    }

    /**
     * Lazily read the existing config at the start of the transaction.
     * @returns {Promise<import('../config/structure').Config|null>}
     */
    async getExistingConfig() {
        if (this.configFile === undefined) {
            throw new Error('getExistingConfig() called outside of a transaction');
        }
        if (this.existingConfigCache !== null) {
            return this.existingConfigCache;
        }
        if (this.configFile === null) {
            this.existingConfigCache = null;
            return null;
        }
        try {
            const configResult = await configStorage.readConfig(
                this.capabilities,
                this.configFile
            );
            const config = require('../config');
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
                    'Found invalid config object in file'
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
        } catch {
            this.existingConfigCache = null;
            return this.existingConfigCache;
        }
    }

    /**
     * Lazily read events existing at transaction start.
     * @returns {Promise<Array<import('../event/structure').Event>>}
     */
    async getExistingEntries() {
        if (!this.dataFile) {
            throw new Error('getExistingEntries() called outside of a transaction');
        }
        if (this.existingEntriesCache !== null) {
            return this.existingEntriesCache;
        }
        try {
            const objects = await readObjects(this.capabilities, this.dataFile);
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
                        'Found invalid object in data.json, skipping'
                    );
                } else {
                    validEvents.push(result);
                }
            }
            this.existingEntriesCache = validEvents;
            return this.existingEntriesCache;
        } catch {
            this.existingEntriesCache = [];
            return this.existingEntriesCache;
        }
    }
}

/** @typedef {EventLogStorageClass} EventLogStorage */

module.exports = { EventLogStorageClass };
