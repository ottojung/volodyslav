
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
const { fromISOString } = require("../../datetime");

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
 *   all_events -> sorted_events_descending
 *   sorted_events_descending -> sorted_events_ascending   (O(n) reverse)
 *   sorted_events_descending -> last_entries(n)            (O(1) slice, parameterised by n)
 *   sorted_events_ascending  -> first_entries(n)           (O(1) slice, parameterised by n)
 *   all_events -> events_count                            (O(1) length)
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
            output: "sorted_events_descending",
            inputs: ["all_events"],
            /**
             * Sorts all events by date descending (most recent first) using a
             * Schwartzian transform: parse each date string once, sort by the
             * parsed values, then extract the serialized events.  This avoids
             * repeated fromISOString() calls inside the sort comparator.
             */
            computor: async (inputs, _oldValue, _bindings) => {
                const allEventsEntry = inputs[0];
                if (!allEventsEntry || allEventsEntry.type !== "all_events") {
                    return { type: "sorted_events_descending", events: [] };
                }

                const eventsWithDates = allEventsEntry.events.map(event => ({
                    event,
                    date: fromISOString(event.date),
                }));
                eventsWithDates.sort((a, b) => b.date.compare(a.date));
                const sorted = eventsWithDates.map(({ event }) => event);
                return { type: "sorted_events_descending", events: sorted };
            },
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "sorted_events_ascending",
            inputs: ["sorted_events_descending"],
            /**
             * Derives ascending order from the already-sorted descending list
             * with a simple O(n) reverse, avoiding a second O(n log n) sort.
             */
            computor: async (inputs, _oldValue, _bindings) => {
                const descEntry = inputs[0];
                if (!descEntry || descEntry.type !== "sorted_events_descending") {
                    return { type: "sorted_events_ascending", events: [] };
                }
                return {
                    type: "sorted_events_ascending",
                    events: descEntry.events.slice().reverse(),
                };
            },
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "last_entries(n)",
            inputs: ["sorted_events_descending"],
            /**
             * Parameterised cache node: caches the first `n` events from the
             * descending-sorted list (i.e. the most-recent n events).  The
             * binding value `n` is passed at pull time; the iterator always
             * uses n = SORTED_EVENTS_CACHE_SIZE.  A small entry can be read
             * from LevelDB very quickly, enabling the common first-page
             * request to bypass the full sorted list entirely.
             */
            computor: async (inputs, _oldValue, bindings) => {
                const n = bindings[0];
                if (typeof n !== "number") {
                    throw new Error(
                        `Expected numeric binding n for last_entries(n) but got: ${JSON.stringify(n)}`
                    );
                }
                const descEntry = inputs[0];
                if (!descEntry || descEntry.type !== "sorted_events_descending") {
                    return { type: "last_entries", n, events: [] };
                }
                return {
                    type: "last_entries",
                    n,
                    events: descEntry.events.slice(0, n),
                };
            },
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "first_entries(n)",
            inputs: ["sorted_events_ascending"],
            /**
             * Parameterised cache node: caches the first `n` events from the
             * ascending-sorted list (i.e. the oldest n events).  Mirrors
             * last_entries(n) for the ascending-order case.
             */
            computor: async (inputs, _oldValue, bindings) => {
                const n = bindings[0];
                if (typeof n !== "number") {
                    throw new Error(
                        `Expected numeric binding n for first_entries(n) but got: ${JSON.stringify(n)}`
                    );
                }
                const ascEntry = inputs[0];
                if (!ascEntry || ascEntry.type !== "sorted_events_ascending") {
                    return { type: "first_entries", n, events: [] };
                }
                return {
                    type: "first_entries",
                    n,
                    events: ascEntry.events.slice(0, n),
                };
            },
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "events_count",
            inputs: ["all_events"],
            /**
             * Caches the total number of events so consumers can access the
             * count without iterating all events.  Currently used by the
             * event iterator to perform cache boundary checks when serving
             * paginated results.
             */
            computor: async (inputs, _oldValue, _bindings) => {
                const allEventsEntry = inputs[0];
                if (!allEventsEntry || allEventsEntry.type !== "all_events") {
                    return { type: "events_count", count: 0 };
                }
                return { type: "events_count", count: allEventsEntry.events.length };
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
