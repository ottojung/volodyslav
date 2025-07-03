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
const gitstore = require("../gitstore");
const event = require("../event");
const { targetPath } = require("../event/asset");
const configStorage = require("../config/storage");
const { makeEventLogStorage } = require("./class");

/** @typedef {import("../filesystem/file").ExistingFile} ExistingFile */
/** @typedef {import("./class").AppendCapabilities} AppendCapabilities */
/** @typedef {import("./class").CopyAssetCapabilities} CopyAssetCapabilities */
/** @typedef {import("./class").CleanupAssetCapabilities} CleanupAssetCapabilities */
/** @typedef {import("./class").EventLogStorageCapabilities} EventLogStorageCapabilities */
/** @typedef {import("./class").EventLogStorage} EventLogStorage */

/**
 * Appends an array of entries to a specified file.
 * Each entry is serialized to JSON format and appended to the file with a newline.
 *
 * @param {AppendCapabilities} capabilities - The minimal capabilities needed for appending entries
 * @param {ExistingFile} file - The file where entries will be appended.
 * @param {Array<import('../event').Event>} entries - An array of objects to append to the file.
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
 * @param {import('../event').Asset[]} assets - An array of assets to copy.
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
    const eventLogStorage = makeEventLogStorage(capabilities);
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
