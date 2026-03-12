
const { isUnchanged } = require("../incremental_graph");
const {
    metaEvents,
    eventContext,
    event: individualEvent,
    calories,
    transcription,
    eventTranscription,
} = require("../individual");
const { transaction } = require("../../event_log_storage");
const { serialize, deserialize } = require("../../event");

/**
 * @typedef {object} Capabilities
 * @property {import('../../ai/calories').AICalories} aiCalories - A calories estimation capability.
 * @property {import('../../ai/transcription').AITranscription} aiTranscription - An AI transcription capability.
 * @property {import('../../random/seed').NonDeterministicSeed} seed - A random number generator instance.
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
 * @property {import('../../generators').Interface} interface - The incremental graph interface capability.
 */

/**
 * Creates the default graph definition for the incremental graph.
 *
 * The `all_events` node reads events directly from the git-backed event log
 * storage on every recompute.  Invalidating it (via `InterfaceClass.update()`)
 * causes the next pull to re-read from disk.
 *
 * The `config` node reads config.json directly from the git-backed event log
 * storage on every recompute.  Invalidating it (via `InterfaceClass.update()`)
 * causes the next pull to re-read from disk.
 *
 * Graph adjacency:
 *   all_events -> event(e)
 *   transcription(a)                            [standalone, no graph inputs]
 *   event(e), transcription(a) -> event_transcription(e, a)
 *   config                                      [standalone, no graph inputs]
 *
 * @param {Capabilities} capabilities - Various capabilities that computors use.
 * @returns {Array<import('../incremental_graph/types').NodeDef>}
 */
function createDefaultGraphDefinition(capabilities) {
    return [
        {
            output: "config",
            inputs: [],
            computor: async (_inputs, _oldValue, _bindings) => {
                const config = await transaction(capabilities, async (storage) => {
                    return await storage.getExistingConfig();
                });
                return { type: "config", config };
            },
            isDeterministic: false,
            hasSideEffects: false,
        },
        {
            output: "all_events",
            inputs: [],
            computor: async (_inputs, _oldValue, _bindings) => {
                const events = await transaction(capabilities, async (storage) => {
                    return await storage.getExistingEntries();
                });
                return { type: "all_events", events: events.map((e) => serialize(capabilities, e)) };
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

                const allEvents = allEventsEntry.events.map(deserialize);

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
            computor: async (inputs, oldValue, bindings) => {
                const firstInput = inputs[0];
                if (!firstInput || firstInput.type !== "all_events") {
                    throw new Error("Expected input of type all_events for event(e) computor");
                }
                const allEvents = firstInput.events;
                const firstBinding = bindings[0];
                if (firstBinding === undefined || typeof firstBinding !== "string") {
                    throw new Error("Expected first binding to be a string for event(e) computor, got " + JSON.stringify(firstBinding));
                }
                if (oldValue !== undefined && oldValue.type !== "event") {
                    throw new Error("Expected oldValue to be of type event or undefined for event(e) computor, got " + JSON.stringify(oldValue));
                }
                return individualEvent.computeEventForId(firstBinding, oldValue, allEvents);
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
                const ev = deserialize(firstInput.value);
                return calories.computeCaloriesForEvent(ev, capabilities);
            },
            isDeterministic: false,
            hasSideEffects: true,
        },
        {
            output: "transcription(a)",
            inputs: [],
            computor: async (_inputs, _oldValue, bindings) => {
                const firstBinding = bindings[0];
                if (typeof firstBinding !== "string") {
                    throw new Error("Expected first binding to be a string for transcription(a) computor, got " + JSON.stringify(firstBinding));
                }
                return transcription.computeTranscriptionForAssetPath(
                    firstBinding,
                    capabilities,
                );
            },
            isDeterministic: false,
            hasSideEffects: true,
        },
        {
            output: "event_transcription(e, a)",
            inputs: ["event(e)", "transcription(a)"],
            computor: async (inputs, _oldValue, bindings) => {
                const eventEntry = inputs[0];
                if (!eventEntry || eventEntry.type !== "event") {
                    throw new Error("Expected event input for event_transcription(e, a) computor");
                }
                const transcriptionEntry = inputs[1];
                if (!transcriptionEntry || transcriptionEntry.type !== "transcription") {
                    throw new Error("Expected transcription input for event_transcription(e, a) computor");
                }
                const audioPath = bindings[1];
                if (typeof audioPath !== "string") {
                    throw new Error("Expected audio path binding at position 1 for event_transcription(e, a) computor, got " + JSON.stringify(audioPath));
                }
                return eventTranscription.computeEventTranscription(
                    deserialize(eventEntry.value),
                    transcriptionEntry.value,
                    audioPath,
                );
            },
            isDeterministic: true,
            hasSideEffects: false,
        },
    ];
}

module.exports = {
    createDefaultGraphDefinition,
};
