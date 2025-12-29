/**
 * Interface class for direct database operations.
 */

/** @typedef {import('../database/class').Database} Database */
/** @typedef {import('../../event').Event} Event */
/** @typedef {import('../dependency_graph').DependencyGraph} DependencyGraph */

const { makeDependencyGraph, isUnchanged } = require("../dependency_graph");
const { metaEvents, eventContext } = require("../individual");
const { freshnessKey } = require("../database");

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

                if (allEventsEntry.type !== "all_events") {
                    return { type: "meta_events", meta_events: [] };
                }

                const allEvents = allEventsEntry.events;

                /** @type {Array<import('../individual/meta_events').MetaEvent>} */
                let currentMetaEvents = [];
                if (oldValue && oldValue.type === "meta_events") {
                    currentMetaEvents = oldValue.meta_events;
                }

                const result = metaEvents.computeMetaEvents(
                    allEvents,
                    currentMetaEvents
                );

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

                if (metaEventsEntry.type !== "meta_events") {
                    return { type: "event_context", contexts: [] };
                }

                const metaEventsArray = metaEventsEntry.meta_events;
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
     * Sets freshness to "dirty" and marks all dependents as "potentially-dirty".
     * @param {Array<Event>} all_events - Array of events to store
     * @returns {Promise<void>}
     */
    async update(all_events) {
        const serializedEvents = all_events; // Events are already in serialized form.
        /** @type {import('../database/types').AllEventsEntry} */
        const value = { events: serializedEvents, type: "all_events" };

        // Store the value
        await this.database.put("all_events", value);

        // Mark this key as dirty
        await this.database.put(freshnessKey("all_events"), "dirty");

        // Mark all dependents as potentially-dirty
        await this.markDependentsAsPotentiallyDirty("all_events");
    }

    /**
     * Recursively marks all dependent nodes as potentially-dirty.
     * @private
     * @param {string} changedKey - The key that was changed
     * @returns {Promise<void>}
     */
    async markDependentsAsPotentiallyDirty(changedKey) {
        const graphDef = createDefaultGraphDefinition();

        // Find all nodes that depend on the changed key
        for (const node of graphDef) {
            if (node.inputs.includes(changedKey)) {
                const currentFreshness = await this.database.get(
                    freshnessKey(node.output)
                );

                // Only update if not already dirty (dirty stays dirty)
                if (currentFreshness !== "dirty") {
                    await this.database.put(
                        freshnessKey(node.output),
                        "potentially-dirty"
                    );

                    // Recursively mark dependents of this node
                    await this.markDependentsAsPotentiallyDirty(node.output);
                }
            }
        }
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
