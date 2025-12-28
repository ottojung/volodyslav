/**
 * DependencyGraph class for managing event dependencies.
 */

/** @typedef {import('./types').DependencyGraphCapabilities} DependencyGraphCapabilities */
/** @typedef {import('./types').Event} Event */
/** @typedef {import('./types').Database} Database */

/**
 * A dependency graph that manages event relationships and storage.
 */
class DependencyGraphClass {
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
            value: { events: serializedEvents, type: "events" },
            isDirty: true,
        });
    }
}

/**
 * Factory function to create a DependencyGraph instance.
 * @param {Database} database - The database instance
 * @returns {DependencyGraphClass}
 */
function makeDependencyGraph(database) {
    return new DependencyGraphClass(database);
}

/**
 * Type guard for DependencyGraph.
 * @param {unknown} object
 * @returns {object is DependencyGraphClass}
 */
function isDependencyGraph(object) {
    return object instanceof DependencyGraphClass;
}

/** @typedef {DependencyGraphClass} DependencyGraph */

module.exports = {
    makeDependencyGraph,
    isDependencyGraph,
};
