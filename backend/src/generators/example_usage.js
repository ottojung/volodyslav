/**
 * Example of using DependencyGraph with meta_events generator.
 * 
 * This example shows how to:
 * 1. Use Interface to update all_events
 * 2. Configure DependencyGraph to propagate changes from all_events to meta_events
 * 3. Use the step() method to process dirty flags
 */

const { get: getDatabase } = require('./database');
const { makeInterface } = require('./interface');
const { makeDependencyGraph } = require('./dependency_graph');
const { metaEvents } = require('./individual');

const { computeMetaEvents } = metaEvents;

/** @typedef {import('./database/types').DatabaseCapabilities} DatabaseCapabilities */
/** @typedef {import('./database/types').DatabaseEntry} DatabaseEntry */

/**
 * Example usage of the new DependencyGraph API.
 * @param {DatabaseCapabilities} capabilities
 */
async function exampleUsage(capabilities) {
    // 1. Get database instance
    const db = await getDatabase(capabilities);

    // 2. Create Interface for direct database updates
    const iface = makeInterface(db);

    // 3. Define the dependency graph
    // The graph describes how data flows from inputs to outputs
    const graphDefinition = [
        {
            output: "meta_events",
            inputs: ["all_events"],
            /**
             * @param {Array<DatabaseEntry>} inputs
             * @param {DatabaseEntry | undefined} oldValue
             */
            computor: (inputs, oldValue) => {
                // Extract all_events from the input
                const allEventsEntry = inputs[0];
                if (!allEventsEntry) {
                    return { type: "meta_events", meta_events: [] };
                }

                // Type guard for AllEventsEntry
                if (allEventsEntry.value.type !== "all_events") {
                    return { type: "meta_events", meta_events: [] };
                }

                const allEvents = allEventsEntry.value.events;

                // Get current meta_events
                /** @type {Array<import('./individual/meta_events').MetaEvent>} */
                let currentMetaEvents = [];
                if (oldValue && oldValue.value.type === "meta_events") {
                    currentMetaEvents = oldValue.value.meta_events;
                }

                // Compute new meta_events
                const newMetaEvents = computeMetaEvents(allEvents, currentMetaEvents);

                return {
                    type: "meta_events",
                    meta_events: newMetaEvents,
                };
            },
        },
    ];

    // 4. Create DependencyGraph with the definition
    const graph = makeDependencyGraph(db, graphDefinition);

    // 5. Update all_events using Interface
    // Note: In real usage, these would be proper Event objects with EventId
    await iface.update([
        /** @type {any} */ ({ id: "1", type: "test", description: "Event 1" }),
        /** @type {any} */ ({ id: "2", type: "test", description: "Event 2" }),
    ]);

    // 6. Propagate changes through the graph
    let propagated = await graph.step();
    while (propagated) {
        propagated = await graph.step();
    }

    // 7. Read the computed meta_events
    const metaEventsEntry = await db.get("meta_events");
    if (metaEventsEntry && metaEventsEntry.value.type === "meta_events") {
        console.log("Computed meta_events:", metaEventsEntry.value.meta_events);
    }

    await db.close();
}

module.exports = {
    exampleUsage,
};
