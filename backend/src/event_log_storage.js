/**
 * Implements atomic, Git-based storage for event log entries and their assets.
 *
 * Call `transaction(transformation)` with a function that uses
 * `storage.addEntry(entry, assets)` to queue log entries and assets. The
 * process appends entries to `data.json`, copies assets into the repository,
 * commits, and pushes all changes in one transaction. If any step fails,
 * copied assets are removed before the error is rethrown.
 */

const path = require("path");
const { eventLogDirectory } = require("./environment");
const { appendFile, copyFile } = require("fs/promises");
const gitstore = require("./gitstore");
const event = require("./event");
const { logWarning } = require("./logger");
const { targetPath } = require("./event/asset");

/** @typedef {import('./filesystem/delete_file').FileDeleter} FileDeleter */

/**
 * @class
 * @description A class to manage the storage of event log entries.
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
     * @constructor
     * Initializes an empty event log storage.
     */
    constructor() {
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
}

/** @typedef {EventLogStorageClass} EventLogStorage */

/**
 * Appends an array of entries to a specified file.
 * Each entry is serialized to JSON format and appended to the file with a newline.
 *
 * @param {string} filePath - The path to the file where entries will be appended.
 * @param {Array<import('./event').Event>} entries - An array of objects to append to the file.
 * @returns {Promise<void>} - A promise that resolves when all entries are appended.
 *
 * Notes and Gotchas:
 * - Uses `JSON.stringify(entry, null, "\t")` to pretty-print with tabs. This produces multi-line JSON.
 *   Consumers must parse complex blocks rather than line-by-line JSON.
 * - Each `appendFile` call opens and closes the file; for high-volume writes, batching or streaming may be more efficient.
 */
async function appendEntriesToFile(filePath, entries) {
    for (const entry of entries) {
        const serialized = event.serialize(entry);
        const eventString = JSON.stringify(serialized, null, "\t");
        await appendFile(filePath, eventString + "\n", "utf8");
    }
}

/**
 * New helper to copy all queued assets into the worktree
 * @param {import('./event').Asset[]} assets - An array of assets to copy.
 * @returns {Promise<void>} - A promise that resolves when all assets are copied.
 */
async function copyAssets(assets) {
    for (const asset of assets) {
        await copyFile(asset.filepath, targetPath(asset));
    }
}

/**
 * @typedef {(eventLogStorage: EventLogStorage) => Promise<void>} Transformation
 */

/**
 * Performs a Git-backed transaction using the given storage and transformation.
 * @param {EventLogStorage} eventLogStorage - The event log storage instance.
 * @param {Transformation} transformation - Async callback to apply to the storage.
 * @returns {Promise<void>}
 */
async function performGitTransaction(eventLogStorage, transformation) {
    const gitDirectory = eventLogDirectory();
    await gitstore.transaction(gitDirectory, async (store) => {
        const workTree = await store.getWorkTree();
        const dataPath = path.join(workTree, "data.json");

        // Run user-provided transformation to accumulate entries
        await transformation(eventLogStorage);

        // Persist queued entries
        await appendEntriesToFile(dataPath, eventLogStorage.getNewEntries());

        // Commit queued changes
        await store.commit("Event log storage update");

        // Copy any queued assets
        const assets = eventLogStorage.getNewAssets();
        await copyAssets(assets);
    });
}

/**
 * Cleans up all copied assets by removing their files.
 * @param {FileDeleter} deleter - A file deleter instance.
 * @param {EventLogStorage} eventLogStorage - The storage containing asset references.
 * @returns {Promise<void>}
 */
async function cleanupAssets(deleter, eventLogStorage) {
    const assets = eventLogStorage.getNewAssets();
    for (const asset of assets) {
        try {
            await deleter.delete(asset.filepath);
        } catch {
            logWarning(
                {
                    file: asset.filepath,
                    error: "error occurred",
                    directory: eventLogDirectory(),
                },
                `Failed to remove asset file ${asset.filepath}. This may be due to the file being in use or not existing.`
            );
        }
    }
}

/**
 * Applies a transformation within a Git-backed event log transaction.
 * @param {FileDeleter} deleter - A file deleter instance.
 * @param {Transformation} transformation - The transformation to execute.
 * @returns {Promise<void>}
 */
async function transaction(deleter, transformation) {
    const eventLogStorage = new EventLogStorageClass();
    try {
        await performGitTransaction(eventLogStorage, transformation);
    } catch (error) {
        // If anything goes wrong, clean up all copied assets and rethrow.
        // Note: we do not wait for the cleanup to finish.
        cleanupAssets(deleter, eventLogStorage);
        throw error;
    }
}

module.exports = { transaction };
