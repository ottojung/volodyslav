/**
 * Interface class for direct database operations.
 */

/** @typedef {import('../database/class').Database} Database */
/** @typedef {import('../../event').Event} Event */

/**
 * An interface for direct database operations.
 * Provides methods to update the database with events.
 */
class InterfaceClass {
    /**
     * The underlying database instance.
     * @private
     * @type {Database}
     */
    database;

    /**
     * @constructor
     * @param {Database} database - The database instance
     */
    constructor(database) {
        this.database = database;
    }

    /**
     * Updates the all_events field in the database with the provided events.
     * @param {Array<Event>} all_events - Array of events to store
     * @returns {Promise<void>}
     */
    async update(all_events) {
        const serializedEvents = all_events; // Events are already in serialized form.
        await this.database.put("all_events", {
            value: { events: serializedEvents, type: "all_events" },
            isDirty: true,
        });
    }
}

/**
 * Factory function to create an Interface instance.
 * @param {Database} database - The database instance
 * @returns {InterfaceClass}
 */
function makeInterface(database) {
    return new InterfaceClass(database);
}

/**
 * Type guard for Interface.
 * @param {unknown} object
 * @returns {object is InterfaceClass}
 */
function isInterface(object) {
    return object instanceof InterfaceClass;
}

/** @typedef {InterfaceClass} Interface */

module.exports = {
    makeInterface,
    isInterface,
};
