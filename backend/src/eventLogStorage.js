/**
 * @file eventLogStorage.js
 * @description This module handles the storage of event log entries.
 */

// TODO: handle assets here too.

const path = require("path");
const os = require("os");
const { eventLogDirectory } = require("./environment");
const { copyFile, writeFile, appendFile, rename } = require("fs/promises");

/** @typedef Event
 * @type {Object}
 * @property {string} date - The date of the event.
 * @property {string} original - The original input of the event.
 * @property {string} input - The processed input of the event.
 * @property {Object} modifiers - Modifiers applied to the event.
 * @property {string} type - The type of the event.
 * @property {string} description - A description of the event.
 */

/**
 * @class EventLogStorage
 * @description A class to manage the storage of event log entries.
 */
class EventLogStorage {
    /**
     * A private property to store the entries.
     * @private
     * @type {Array<Event>}
     */
    entries;

    /**
     * @constructor
     * Initializes an empty event log storage.
     */
    constructor() {
        this.entries = [];
    }

    /**
     * Adds an entry to the event log.
     * @param {Event} entry - The entry to add.
     */
    addEntry(entry) {
        this.entries.push(entry);
    }

    /**
     * Retrieves all entries from the event log.
     * @returns {Array<Event>} - The list of entries.
     */
    getEntries() {
        return this.entries;
    }
}

/**
 * @param {string} originalPath
 * @param {string} resultPath
 * @returns {Promise<void>}
 */
async function copyOrTouch(originalPath, resultPath) {
    try {
        await copyFile(originalPath, resultPath);
    } catch (error) {
        if (error instanceof Error) {
            if ("code" in error && error.code === "ENOENT") {
                await writeFile(resultPath, "", "utf8");
                return;
            }
        }

        throw error;
    }
}

/**
 * Appends an array of entries to a specified file.
 * Each entry is serialized to JSON format and appended to the file with a newline.
 *
 * @param {string} filePath - The path to the file where entries will be appended.
 * @param {Array<Object>} entries - An array of objects to append to the file.
 * @returns {Promise<void>} - A promise that resolves when all entries are appended.
 */
async function appendEntriesToFile(filePath, entries) {
    for (const entry of entries) {
        const entryString = JSON.stringify(entry, null, "\t");
        await appendFile(filePath, entryString + "\n", "utf8");
    }
}

/** @typedef {(eventLogStorage: EventLogStorage) => void} Transformation
 */

/**
 * @param {Transformation} transformation
 * @returns {Promise<void>}
 * @description Applies a transformation to the event log storage.
 */
async function transaction(transformation) {
    const eventLogDir = eventLogDirectory();
    const originalDataPath = path.join(eventLogDir, "data.json");
    const tempDataPath = path.join(os.tmpdir(), `data.json`);
    const eventLogStorage = new EventLogStorage();

    // try to copy the original; if missing, start with empty
    await copyOrTouch(originalDataPath, tempDataPath);

    // run the transformation
    transformation(eventLogStorage);

    // append entries to the temporary file
    await appendEntriesToFile(tempDataPath, eventLogStorage.getEntries());

    // atomically replace original
    await rename(tempDataPath, originalDataPath);

    await commitChanges();
}

// Create a new module for diary storage
async function commitChanges() {
    // TODO: implement the rest.
    throw new Error("Not implemented");
}

module.exports = { transaction, EventLogStorage }; 
