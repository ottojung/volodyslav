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
const { appendFile } = require("fs/promises");
const gitstore = require("./gitstore");
const event = require("./event/event");

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
     * @type {Array<import('./event/event').Event>}
     */
    newEntries;

    /**
     * @constructor
     * Initializes an empty event log storage.
     */
    constructor() {
        this.newEntries = [];
    }

    /**
     * Adds an entry to the event log.
     * @param {import('./event/event').Event} entry - The entry to add.
     */
    addEntry(entry) {
        this.newEntries.push(entry);
    }

    /**
     * Retrieves all new entries from the event log.
     * @returns {Array<import('./event/event').Event>} - The list of entries.
     */
    getNewEntries() {
        return this.newEntries;
    }
}

/** @typedef {EventLogStorageClass} EventLogStorage */

/**
 * Appends an array of entries to a specified file.
 * Each entry is serialized to JSON format and appended to the file with a newline.
 *
 * @param {string} filePath - The path to the file where entries will be appended.
 * @param {Array<import('./event/event').Event>} entries - An array of objects to append to the file.
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
 * @typedef {(eventLogStorage: EventLogStorage) => Promise<void>} Transformation
 */

/**
 * @param {Transformation} transformation
 *
 * Applies a transformation to an in-memory event log storage, then persists the results via Git.
 *
 * @param {Transformation} transformation - Async callback receiving an EventLogStorage instance.
 *                                         Call `addEntry(...)` to queue events.
 * @returns {Promise<void>} - Resolves when changes are committed and pushed, rejects on any error.
 * 
 * Detailed Behavior:
 * 1. Construct a fresh `EventLogStorageClass`, with an empty `newEntries`.
 * 2. Determine the bare repository directory via `eventLogDirectory()`.
 * 3. Invoke `gitstore.transaction` with the bare repo path:
 *    a. Clone the bare repo into a temporary worktree.
 *    b. Execute the `transformation` callback, populating `newEntries`.
 *    c. Call `appendEntriesToFile` to write queued entries to `<workTree>/data.json`.
 *    d. Commit changes using the message "Event log storage update" and push.
 *
 * Unexpected or Non-Obvious Details:
 * - If no entries were added, the `git commit` step fails (no changes to commit),
 *   causing the entire transaction to reject. This is intentional to catch no-op calls.
 * - The temporary worktree is removed in a finally block, so logs or intermediate files are not left behind.
 */
async function transaction(transformation) {
    const eventLogStorage = new EventLogStorageClass();
    const gitDirectory = eventLogDirectory();  // Bare repo path, often configured via environment

    // Perform an atomic Git-backed transaction: clone, modify, commit, push, cleanup
    await gitstore.transaction(gitDirectory, async (store) => {
        const workTree = await store.getWorkTree(); // Path to temp directory clone
        const dataPath = path.join(workTree, "data.json"); // File within worktree to append entries

        // Run user-provided transformation to accumulate entries
        await transformation(eventLogStorage);

        // Persist queued entries to disk before commit
        await appendEntriesToFile(
            dataPath,
            eventLogStorage.getNewEntries()
        );

        // Stage and commit all changes; failure indicates no entries were added
        await store.commit("Event log storage update");
    });
}

module.exports = { transaction };
