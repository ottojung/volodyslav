
const { isUnchanged, isSchemaCompatibility } = require("../incremental_graph");
const { metaEvents, eventContext, event: individualEvent, calories } = require("../individual");
const { transaction } = require("../../event_log_storage");

/**
 * @typedef {object} Capabilities
 * @property {import('../../ai/calories').AICalories} aiCalories - A calories estimation capability.
 * @property {import('../../logger').Logger} logger - A logger instance.
 * @property {import('../../filesystem/reader').FileReader} reader - A file reader instance.
 * @property {import('../../filesystem/writer').FileWriter} writer - A file writer instance.
 * @property {import('../../filesystem/creator').FileCreator} creator - A file creator instance.
 * @property {import('../../filesystem/checker').FileChecker} checker - A file checker instance.
 * @property {import('../../filesystem/deleter').FileDeleter} deleter - A file deleter instance.
 * @property {import('../../filesystem/copier').FileCopier} copier - A file copier instance.
 * @property {import('../../filesystem/appender').FileAppender} appender - A file appender instance.
 * @property {import('../../subprocess/command').Command} git - A command instance for Git operations.
 * @property {import('../../environment').Environment} environment - An environment instance.
 * @property {import('../../datetime').Datetime} datetime - Datetime utilities.
 * @property {import('../../sleeper').SleepCapability} sleeper - A sleeper instance.
 */

/**
 * Creates the default graph definition for the incremental graph.
 *
 * The `all_events` node reads events directly from the git-backed event log
 * storage on every recompute.  Invalidating it (via `InterfaceClass.update()`)
 * causes the next pull to re-read from disk.
 *
 * @param {Capabilities} capabilities - Various capabilities that computors use.
 * @returns {Array<import('../incremental_graph/types').NodeDef>}
 */
function createDefaultGraphDefinition(capabilities) {
    return [
        {
            output: "all_events",
            inputs: [],
            computor: async (_inputs, _oldValue, _bindings) => {
                const events = await transaction(capabilities, async (storage) => {
                    return await storage.getExistingEntries();
                });
                return { type: "all_events", events };
            },
            isDeterministic: false,
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

                if (isUnchanged(result) && oldValue !== undefined) {
                    return result;
                }

                return {
                    type: "meta_events",
                    meta_events: isUnchanged(result) ? currentMetaEvents : result,
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
            output: "event(e)",
            inputs: ["all_events"],
            computor: async (inputs, _oldValue, bindings) => {
                const firstInput = inputs[0];
                if (!firstInput || firstInput.type !== "all_events") {
                    throw new Error("Expected input of type all_events for event(e) computor");
                }
                const allEvents = firstInput.events;
                const firstBinding = bindings[0];
                if (firstBinding === undefined || typeof firstBinding !== "string") {
                    throw new Error("Expected first binding to be a string for event(e) computor, got " + JSON.stringify(firstBinding));
                }
                return individualEvent.computeEventForId(firstBinding, allEvents);
            },
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "calories(e)",
            inputs: ["event(e)"],
            computor: async (inputs, _oldValue, _bindings) => {
                const firstInput = inputs[0];
                if (!firstInput || firstInput.type !== "event") {
                    throw new Error("Expected input of type event for calories(e) computor");
                }
                const ev = firstInput.value;
                return calories.computeCaloriesForEvent(ev, capabilities);
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
