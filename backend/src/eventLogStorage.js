/**
 * @file eventLogStorage.js
 * @description This module handles the storage of event log entries.
 */

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


/** @typedef {(eventLogStorage: EventLogStorage) => void} Transformation
 */

/**
 * @param {Transformation} transformation
 * @returns {Promise<void>}
 * @description Applies a transformation to the event log storage.
 */
async function transaction(transformation) {
    // Implementation to be added later
}

// Create a new module for diary storage
async function commitChanges() {
    // Implementation to be added later
}

module.exports = { transaction, EventLogStorage }; 
