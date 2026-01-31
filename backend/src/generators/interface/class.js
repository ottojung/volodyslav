/**
 * Interface class for direct database operations.
 */

/** @typedef {import('../incremental_graph/database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../event').Event} Event */
/** @typedef {import('../incremental_graph').IncrementalGraph} IncrementalGraph */
/** @typedef {import('./types').GeneratorsCapabilities} GeneratorsCapabilities */

const path = require('path');
const { makeIncrementalGraph, makeRootDatabase } = require("../incremental_graph");
const { createDefaultGraphDefinition } = require("./default_graph");

/**
 * An interface for direct database operations.
 * Provides methods to update the database with events.
 */
class InterfaceClass {
    /**
     * The incremental graph for propagating changes.
     * @private
     * @type {IncrementalGraph}
     */
    incrementalGraph;

    /**
     * The stored events in the database.
     * @private
     * @type {import('../incremental_graph/database/types').AllEventsEntry}
     */
    events;

    /**
     * @constructor
     * @param {RootDatabase} database - The root database instance
     */
    constructor(database) {
        this.events = { events: [], type: "all_events" };
        this.incrementalGraph = makeIncrementalGraph(
            database,
            createDefaultGraphDefinition(() => this.events)
        );
    }

    /**
     * Updates the all_events field in the database with the provided events.
     * Sets freshness to "dirty" and marks all dependents as "potentially-dirty".
     * @param {Array<Event>} all_events - Array of events to store
     * @returns {Promise<void>}
     */
    async update(all_events) {
        this.events = { events: all_events, type: "all_events" };
        await this.incrementalGraph.invalidate("all_events");
    }

    /**
     * Gets the basic context for a given event.
     * This method uses pull semantics to lazily evaluate only the necessary
     * parts of the incremental graph to get the event context.
     *
     * @param {Event} event - The event to get context for
     * @returns {Promise<Array<Event>>} The context events
     */
    async getEventBasicContext(event) {
        // Pull the event_context node (lazy evaluation)
        const eventContextEntry = await this.incrementalGraph.pull(
            "event_context"
        );

        if (!eventContextEntry || eventContextEntry.type !== "event_context") {
            return [event];
        }

        // Find the context for this specific event
        const contexts = eventContextEntry.contexts;
        const eventIdStr = event.id.identifier;
        const contextEntry = contexts.find((ctx) => ctx.eventId === eventIdStr);

        if (!contextEntry) {
            return [event];
        }

        return contextEntry.context;
    }
}

/**
 * Factory function to create an Interface instance.
 * @param {GeneratorsCapabilities} capabilities
 * @returns {Promise<InterfaceClass>}
 */
async function makeInterface(capabilities) {
    const wd = capabilities.environment.workingDirectory();
    const databasePath = path.join(wd, "generators-database");
    const database = await makeRootDatabase(capabilities, databasePath);
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
