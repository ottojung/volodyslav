/**
 * Interface class for direct database operations.
 */

/** @typedef {import('../dependency_graph/database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../event').Event} Event */
/** @typedef {import('../dependency_graph').DependencyGraph} DependencyGraph */

const { makeDependencyGraph } = require("../dependency_graph");
const { createDefaultGraphDefinition } = require("./default_graph");

/**
 * An interface for direct database operations.
 * Provides methods to update the database with events.
 */
class InterfaceClass {
    /**
     * The dependency graph for propagating changes.
     * @private
     * @type {DependencyGraph}
     */
    dependencyGraph;

    /**
     * @constructor
     * @param {RootDatabase} database - The root database instance
     */
    constructor(database) {
        this.dependencyGraph = makeDependencyGraph(
            database,
            createDefaultGraphDefinition()
        );
    }

    /**
     * Updates the all_events field in the database with the provided events.
     * Sets freshness to "dirty" and marks all dependents as "potentially-dirty".
     * @param {Array<Event>} all_events - Array of events to store
     * @returns {Promise<void>}
     */
    async update(all_events) {
        const serializedEvents = all_events; // Events are already in serialized form.
        /** @type {import('../dependency_graph/database/types').AllEventsEntry} */
        const value = { events: serializedEvents, type: "all_events" };
        await this.dependencyGraph.set("all_events", value);
    }

    /**
     * Gets the basic context for a given event.
     * This method uses pull semantics to lazily evaluate only the necessary
     * parts of the dependency graph to get the event context.
     *
     * @param {Event} event - The event to get context for
     * @returns {Promise<Array<Event>>} The context events
     */
    async getEventBasicContext(event) {
        // Pull the event_context node (lazy evaluation)
        const eventContextEntry = await this.dependencyGraph.pull(
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
 * @param {RootDatabase} database - The root database instance
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
