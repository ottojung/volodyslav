
const { isUnchanged, isSchemaCompatibility } = require("../incremental_graph");
const { metaEvents, eventContext } = require("../individual");

/**
 * @typedef {object} Capabilities
 * @property {import('../../ai/calories').AICalories} aiCalories - A calories estimation capability.
 */

/**
 * Creates the default graph definition for the incremental graph.
 * @param {Capabilities} capabilities - Various capabilities that computors use.
 * @param {() => import('../incremental_graph/database/types').AllEventsEntry} getAllEvents - Function to get the current all events entry
 * @returns {Array<import('../incremental_graph/types').NodeDef>}
 */
function createDefaultGraphDefinition(capabilities, getAllEvents) {
    return [
        {
            output: "all_events",
            inputs: [],
            computor: async (_inputs, _oldValue, _bindings) => {
                return getAllEvents();
            },
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "meta_events",
            inputs: ["all_events"],
            computor: async (inputs, oldValue, _bindings) => {
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
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "event_context",
            inputs: ["meta_events"],
            computor: async (inputs, _oldValue, _bindings) => {
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
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "input(e)",
            inputs: ["all_events"],
            computor: async (inputs, _oldValue, bindings) => {
                const eventId = String(bindings[0]);
                const allEventsEntry = inputs[0];
                if (!allEventsEntry || allEventsEntry.type !== "all_events") {
                    return { type: "input", value: "" };
                }
                const event = allEventsEntry.events.find(
                    (e) =>
                        String(e.id && e.id.identifier !== undefined ? e.id.identifier : e.id) === eventId
                );
                if (!event) {
                    return { type: "input", value: "" };
                }
                return { type: "input", value: event.input ?? "" };
            },
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "calories(e)",
            inputs: ["input(e)"],
            computor: async (inputs, _oldValue, _bindings) => {
                const inputEntry = inputs[0];
                if (!inputEntry || inputEntry.type !== "input") {
                    return { type: "calories", value: 0 };
                }
                return capabilities.aiCalories.estimateCalories(
                    inputEntry.value
                );
            },
            isDeterministic: false,
            hasSideEffects: true,
        },
    ];
}

/**
 * Creates the default migration callback for the incremental graph.
 *
 * For every node materialized in the previous version:
 * - If the node's functor still exists in the new schema at the same arity,
 *   it is invalidated so it will be recomputed on the next pull.
 * - If the node's functor is absent from the new schema (or has a different
 *   arity), it is deleted.
 *
 * This is the conservative-safe strategy for any application-version bump:
 * no cached data is silently kept stale, and no incompatible nodes survive
 * into the new schema.
 *
 * @returns {(storage: import('../incremental_graph/migration_storage').MigrationStorage) => Promise<void>}
 */
function createDefaultMigrationCallback() {
    return async function defaultMigrationCallback(storage) {
        for await (const nodeKey of storage.listMaterializedNodes()) {
            try {
                await storage.invalidate(nodeKey);
            } catch (e) {
                if (isSchemaCompatibility(e)) {
                    await storage.delete(nodeKey);
                } else {
                    throw e;
                }
            }
        }
    };
}

module.exports = {
    createDefaultGraphDefinition,
    createDefaultMigrationCallback,
};
