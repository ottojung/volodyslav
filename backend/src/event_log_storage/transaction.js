/**
 * Implements transactional storage updates for event log entries and config.
 *
 * Call `transaction(transformation)` with a function that uses
 * `storage.addEntry(entry, assets)` to queue entries and assets and
 * `storage.setConfig(config)` to queue config updates. Event and config values
 * are persisted through the incremental graph; queued assets are copied before
 * the graph update and cleaned up again if the graph update fails.
 */

const path = require("path");
const event = require("../event");
const asset = event.asset;
const { targetPath } = asset;
const { make: makeEventLogStorage } = require("./class");

/** @typedef {import("../event").Asset} Asset */
/** @typedef {import("./class").EventLogStorage} EventLogStorage */
/** @typedef {import("./class").EventLogStorageCapabilities} EventLogStorageCapabilities */

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
        const buffer = await asset.file.data();
        const destFile = await capabilities.creator.createFile(destination);
        await capabilities.writer.writeBuffer(destFile, buffer);
    }
}

/**
 * @param {EventLogStorageCapabilities} capabilities
 * @param {EventLogStorage} eventLogStorage
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
 * @typedef {(eventLogStorage: EventLogStorage) => Promise<T>} Transformation
 */

/**
 * Applies a transformation within an event log transaction.
 * @template T
 * @param {EventLogStorageCapabilities} capabilities
 * @param {Transformation<T>} transformation
 * @returns {Promise<T>}
 */
async function transaction(capabilities, transformation) {
    const eventLogStorage = makeEventLogStorage(capabilities);
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
