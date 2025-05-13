/**
 * @file eventLogStorage.js
 * @description This module handles the storage of event log entries using a Git-based strategy.
 *
 * Storage Strategy:
 * - Entries are appended to a `data.json` file in a bare Git repository under `eventLogDirectory()`.
 * - Uses `gitstore.transaction` to safely clone, apply changes, commit, and push in a temporary worktree.
 *
 * Atomicity and Error Behavior:
 * - If the transformation adds no entries, the underlying `git commit` will fail due to no staged changes,
 *   causing the transaction to reject. This ensures that empty operations are not silently ignored.
 * - All filesystem and Git operations occur in a sandboxed temporary directory, cleaned up on completion or error.
 */

// TODO: handle assets here too.

const path = require("path");
const { eventLogDirectory } = require("./environment");
const { appendFile, copyFile } = require("fs/promises");
const gitstore = require("./gitstore");
const event = require("./event");

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
 * @param {string} workTree - The path to the temporary worktree.
 * @param {Array<import('./event').Asset>} assets - An array of assets to copy.
 * @returns {Promise<void>} - A promise that resolves when all assets are copied.
 */
async function copyAssets(workTree, assets) {
    for (const asset of assets) {
        const assetDir = path.join(workTree, asset.identifier.identifier);
        const assetTargetPath = path.join(assetDir, asset.path);
        await copyFile(asset.path, assetTargetPath);
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
        await copyAssets(workTree, assets);
    });
}

/**
 * Applies a transformation within a Git-backed event log transaction.
 * @param {Transformation} transformation - The transformation to execute.
 * @returns {Promise<void>}
 */
async function transaction(transformation) {
    const eventLogStorage = new EventLogStorageClass();
    await performGitTransaction(eventLogStorage, transformation);
}

module.exports = { transaction };
