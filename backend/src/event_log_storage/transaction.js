const path = require("path");
const event = require("../event");
const asset = event.asset;
const { targetPath } = asset;
const config = require("../config");
const configStorage = config.storage;
const { make: makeEventLogStorage } = require("./class");
const { isFileNotFoundError } = require("../filesystem").checker;

/** @typedef {import("./types").CopyAssetCapabilities} CopyAssetCapabilities */
/** @typedef {import("./types").CleanupAssetCapabilities} CleanupAssetCapabilities */
/** @typedef {import("./types").EventLogStorageCapabilities} EventLogStorageCapabilities */
/** @typedef {import("./class").EventLogStorage} EventLogStorage */

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
 * @template T
 * @typedef {(eventLogStorage: EventLogStorage) => Promise<T>} Transformation
 */

/**
 * @param {EventLogStorageCapabilities} capabilities
 * @returns {string}
 */
function pathToConfig(capabilities) {
    return path.join(capabilities.environment.workingDirectory(), "config.json");
}

/**
 * @param {EventLogStorageCapabilities} capabilities
 * @param {string} filepath
 * @returns {Promise<import("../filesystem/file").ExistingFile | null>}
 */
async function instantiateIfExists(capabilities, filepath) {
    return await capabilities.checker.instantiate(filepath).catch((error) => {
        if (isFileNotFoundError(error)) {
            return null;
        }
        throw error;
    });
}

/**
 * @param {CopyAssetCapabilities} capabilities
 * @param {import("../event").Asset[]} assets
 * @returns {Promise<void>}
 */
async function copyAssets(capabilities, assets) {
    for (const asset of assets) {
        const target = targetPath(capabilities, asset);
        await capabilities.creator.createDirectory(path.dirname(target));
        await capabilities.copier.copyFile(asset.file, target);
    }
}

/**
 * @param {CleanupAssetCapabilities} capabilities
 * @param {EventLogStorage} eventLogStorage
 * @returns {Promise<void>}
 */
async function cleanupAssets(capabilities, eventLogStorage) {
    for (const asset of eventLogStorage.getNewAssets()) {
        const assetPath = targetPath(capabilities, asset);
        try {
            await capabilities.deleter.deleteFile(assetPath);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            capabilities.logger.logWarning(
                {
                    file: assetPath,
                    error: message,
                },
                `Failed to remove asset file ${assetPath}. This may be due to the file being in use or not existing.`
            );
        }
    }
}

/**
 * @template T
 * @param {EventLogStorageCapabilities} capabilities
 * @param {Transformation<T>} transformation
 * @returns {Promise<T>}
 */
async function transaction(capabilities, transformation) {
    const eventLogStorage = makeEventLogStorage(capabilities);
    eventLogStorage.configFile = await instantiateIfExists(
        capabilities,
        pathToConfig(capabilities)
    );

    try {
        const result = await transformation(eventLogStorage);
        const newEntries = eventLogStorage.getNewEntries();
        const deletedIds = Array.from(eventLogStorage.getDeletedIds());
        const deletedIdStrings = new Set(deletedIds.map((id) => id.identifier));
        const newConfig = eventLogStorage.getNewConfig();
        const entriesChanged = newEntries.length > 0 || deletedIdStrings.size > 0;

        /** @type {Array<import("../event").Event>} */
        let nextEntries = [];
        if (entriesChanged) {
            const existingEntries = await capabilities.interface.getAllEvents();
            const remainingEntries = existingEntries.filter(
                (entry) => !deletedIdStrings.has(entry.id.identifier)
            );
            const absorbedIds = eventLogStorage.getAbsorbedDeletionIds();
            const hasExistingDeletion = remainingEntries.length < existingEntries.length;
            const hasAbsorbedDeletion = Array.from(deletedIdStrings).some((id) =>
                absorbedIds.has(id)
            );

            if (deletedIdStrings.size > 0 && !hasExistingDeletion && !hasAbsorbedDeletion) {
                throw new EntryNotFoundError(
                    `Entry not found: ${Array.from(deletedIdStrings).join(", ")}`
                );
            }

            nextEntries = [...remainingEntries, ...newEntries];
        }

        await copyAssets(capabilities, eventLogStorage.getNewAssets());

        if (newConfig !== null) {
            await configStorage.writeConfig(
                capabilities,
                pathToConfig(capabilities),
                newConfig
            );
        }

        if (entriesChanged) {
            await capabilities.interface.update(nextEntries);
        }

        if (newConfig !== null && capabilities.interface.isInitialized()) {
            await capabilities.interface.invalidateGraphNode("config");
        }

        return result;
    } catch (error) {
        await cleanupAssets(capabilities, eventLogStorage);
        throw error;
    }
}

module.exports = { transaction, isEntryNotFoundError };
