/**
 * Interface class for direct database operations.
 */

/** @typedef {import('../database/class').Database} Database */
/** @typedef {import('../../event').Event} Event */
/** @typedef {import('../dependency_graph').DependencyGraph} DependencyGraph */

const { makeDependencyGraph } = require("../dependency_graph");
const { metaEvents, eventContext } = require("../individual");

/**
 * Creates the default graph definition for the dependency graph.
 * @returns {Array<import('../dependency_graph/types').GraphNode>}
 */
function createDefaultGraphDefinition() {
    return [
        {
            output: "meta_events",
            inputs: ["all_events"],
            computor: (inputs, oldValue) => {
                const allEventsEntry = inputs[0];
                if (!allEventsEntry) {
                    return { type: "meta_events", meta_events: [] };
                }

                if (allEventsEntry.value.type !== "all_events") {
                    return { type: "meta_events", meta_events: [] };
                }

                const allEvents = allEventsEntry.value.events;

                /** @type {Array<import('../individual/meta_events').MetaEvent>} */
                let currentMetaEvents = [];
                if (oldValue && oldValue.value.type === "meta_events") {
                    currentMetaEvents = oldValue.value.meta_events;
                }

                const result = metaEvents.computeMetaEvents(
                    allEvents,
                    currentMetaEvents
                );

                const { isUnchanged } = require("../dependency_graph");
                if (isUnchanged(result)) {
                    return result;
                }

                return {
                    type: "meta_events",
                    meta_events: result,
                };
            },
        },
        {
            output: "event_context",
            inputs: ["meta_events"],
            computor: (inputs) => {
                const metaEventsEntry = inputs[0];
                if (!metaEventsEntry) {
                    return { type: "event_context", contexts: [] };
                }

                if (metaEventsEntry.value.type !== "meta_events") {
                    return { type: "event_context", contexts: [] };
                }

                const metaEventsArray = metaEventsEntry.value.meta_events;
                const contexts =
                    eventContext.computeEventContexts(metaEventsArray);

                return {
                    type: "event_context",
                    contexts: contexts,
                };
            },
        },
    ];
}

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
     * The dependency graph for propagating changes.
     * @private
     * @type {DependencyGraph}
     */
    dependencyGraph;

    /**
     * @constructor
     * @param {Database} database - The database instance
     */
    constructor(database) {
        this.database = database;
        this.dependencyGraph = makeDependencyGraph(
            database,
            createDefaultGraphDefinition()
        );
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

    /**
     * Gets the basic context for a given event.
     * This method updates all_events, propagates changes through the dependency graph,
     * and returns the context for the specified event.
     *
     * @param {Event} event - The event to get context for
     * @returns {Promise<Array<Event>>} The context events
     */
    async getEventBasicContext(event) {
        // First, we need to ensure all derived data is up to date
        await this.dependencyGraph.run();

        // Read the event_context from the database
        const eventContextEntry = await this.database.get("event_context");

        if (
            !eventContextEntry ||
            eventContextEntry.value.type !== "event_context"
        ) {
            return [event];
        }

        // Find the context for this specific event
        const contexts = eventContextEntry.value.contexts;
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
