const path = require("path");
const { asset } = require("./event");
const localConfig = require("./local_config");
const { targetPath } = asset;

/**
 * @typedef {import('./event').Event} Event
 * @typedef {import('./event/asset').Asset} Asset
 * @typedef {import('./event/id').EventId} EventId
 * @typedef {import('./config/structure').Config} Config
 * @typedef {import('./filesystem/creator').FileCreator} FileCreator
 * @typedef {import('./filesystem/copier').FileCopier} FileCopier
 * @typedef {import('./filesystem/deleter').FileDeleter} FileDeleter
 * @typedef {import('./filesystem/checker').FileChecker} FileChecker
 * @typedef {import('./filesystem/reader').FileReader} FileReader
 * @typedef {import('./filesystem/writer').FileWriter} FileWriter
 * @typedef {import('./logger').Logger} Logger
 * @typedef {import('./environment').Environment} Environment
 * @typedef {import('./datetime').Datetime} Datetime
 * @typedef {import('./generators').Interface} Interface
 */

/**
 * @typedef {object} Capabilities
 * @property {FileCreator} creator
 * @property {FileCopier} copier
 * @property {FileDeleter} deleter
 * @property {FileChecker} checker
 * @property {FileReader} reader
 * @property {FileWriter} writer
 * @property {Logger} logger
 * @property {Environment} environment
 * @property {Datetime} datetime
 * @property {Interface} interface
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

class LocalDataTransactionClass {
    /** @type {Array<Event>} */ newEntries = [];
    /** @type {Array<Asset>} */ newAssets = [];
    /** @type {Array<EventId>} */ deletedIds = [];
    /** @type {Set<string>} */ absorbedDeletionIds = new Set();
    /** @type {Config | null} */ newConfig = null;
    /** @type {Config | null} */ existingConfigCache = null;
    /** @type {boolean} */ hasExistingConfigCache = false;
    /** @param {Capabilities} capabilities */ constructor(capabilities) {
        this.capabilities = capabilities;
    }
    /** @param {Event} entry @param {Array<Asset>} assets */
    addEntry(entry, assets) {
        this.newEntries.push(entry);
        this.newAssets.push(...assets);
    }
    /** @returns {Array<Event>} */
    getNewEntries() {
        return this.newEntries;
    }
    /** @returns {Array<Asset>} */
    getNewAssets() {
        return this.newAssets;
    }
    /** @param {EventId} id */
    deleteEntry(id) {
        const index = this.newEntries.findIndex((entry) => entry.id.identifier === id.identifier);
        if (index !== -1) {
            this.newEntries.splice(index, 1);
            this.absorbedDeletionIds.add(id.identifier);
            return;
        }
        this.deletedIds.push(id);
    }
    /** @returns {Iterable<EventId>} */
    getDeletedIds() {
        return this.deletedIds;
    }
    /** @returns {Set<string>} */
    getAbsorbedDeletionIds() {
        return this.absorbedDeletionIds;
    }
    /** @param {Config} config */
    setConfig(config) {
        this.newConfig = config;
    }
    /** @returns {Config | null} */
    getNewConfig() {
        return this.newConfig;
    }
    /** @returns {Promise<Config | null>} */
    async getExistingConfig() {
        if (this.hasExistingConfigCache) {
            return this.existingConfigCache;
        }
        this.existingConfigCache = await localConfig.readConfig(this.capabilities);
        this.hasExistingConfigCache = true;
        return this.existingConfigCache;
    }
}

/**
 * @param {Capabilities} capabilities
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
 * @param {Capabilities} capabilities
 * @param {LocalDataTransactionClass} transaction
 * @returns {Promise<void>}
 */
async function cleanupAssets(capabilities, transaction) {
    for (const asset of transaction.getNewAssets()) {
        const destination = targetPath(capabilities, asset);
        try {
            await capabilities.deleter.deleteFile(destination);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            capabilities.logger.logWarning(
                { file: destination, error: message },
                `Failed to remove asset file ${destination}`
            );
        }
    }
}

/**
 * @template T
 * @param {Capabilities} capabilities
 * @param {(transaction: LocalDataTransactionClass) => Promise<T>} transformation
 * @returns {Promise<T>}
 */
async function transaction(capabilities, transformation) {
    const localData = new LocalDataTransactionClass(capabilities);
    try {
        const result = await transformation(localData);
        const deletedIds = Array.from(localData.getDeletedIds()).map((id) => id.identifier);
        const existingEvents = await capabilities.interface.getAllEvents();
        const nextEvents = existingEvents.filter(
            (entry) => !deletedIds.includes(entry.id.identifier)
        );
        const hasExistingDeletion = nextEvents.length < existingEvents.length;
        const allDeletionsWereAbsorbed = deletedIds.every((id) =>
            localData.getAbsorbedDeletionIds().has(id)
        );

        if (
            deletedIds.length > 0 &&
            !hasExistingDeletion &&
            !allDeletionsWereAbsorbed
        ) {
            throw new EntryNotFoundError(`Entry not found: ${deletedIds.join(", ")}`);
        }

        await copyAssets(capabilities, localData.getNewAssets());

        const newConfig = localData.getNewConfig();
        if (newConfig !== null) {
            await localConfig.writeConfig(capabilities, newConfig);
            if (capabilities.interface.isInitialized()) {
                await capabilities.interface.invalidateGraphNode("config");
            }
        }

        if (deletedIds.length > 0 || localData.getNewEntries().length > 0) {
            await capabilities.interface.update([
                ...nextEvents,
                ...localData.getNewEntries(),
            ]);
        }

        return result;
    } catch (error) {
        await cleanupAssets(capabilities, localData);
        throw error;
    }
}

module.exports = {
    transaction,
    isEntryNotFoundError,
};
