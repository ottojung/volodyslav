
const {
    config,
    allEvents,
    sortedEventsDescending,
    sortedEventsAscending,
    lastEntries,
    firstEntries,
    eventsCount,
    metaEvents,
    eventContext,
    event,
    basicContext,
    calories,
    transcription,
    eventTranscription,
    eventAudiosList,
    diarySummary,
} = require("../individual");

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
 * @property {import('../../filesystem/dirscanner').DirScanner} scanner - A directory scanner instance.
 * @property {import('../../subprocess/command').Command} git - A command instance for Git operations.
 * @property {import('../../environment').Environment} environment - An environment instance.
 * @property {import('../../datetime').Datetime} datetime - Datetime utilities.
 * @property {import('../../sleeper').SleepCapability} sleeper - A sleeper instance.
 * @property {import('../../generators').Interface} interface - The incremental graph interface capability.
 */

/**
 * Creates the default graph definition for the incremental graph.
 *
 * The `all_events` node is persisted directly in the incremental graph.
 * `InterfaceClass.update(newEntries)` writes the full serialized event list
 * into the graph, so recomputes never need to read a separate event-log file.
 *
 * The `config` node is persisted directly in the incremental graph.
 * `InterfaceClass.setConfig(config)` writes the full config value via the
 * invalidate/recompute path, so recomputes never need to read config from disk.
 *
 * Graph adjacency:
 *   all_events -> sorted_events_descending
 *   sorted_events_descending -> sorted_events_ascending   (O(n) reverse)
 *   sorted_events_descending -> last_entries(n)            (O(1) slice, parameterised by n)
 *   sorted_events_ascending  -> first_entries(n)           (O(1) slice, parameterised by n)
 *   all_events -> events_count                            (O(1) length)
 *   all_events -> event(e)
 *   all_events -> basic_context(e)
 *   basic_context(e) -> calories(e)
 *   transcription(a)                            [standalone, no graph inputs]
 *   event(e) -> event_audios_list(e)
 *   event_audios_list(e), transcription(a) -> event_transcription(e, a)
 *   config                                      [standalone, no graph inputs]
 *
 * @param {Capabilities} capabilities - Various capabilities that computors use.
 * @param {import('../individual/config/wrapper').ConfigBox} configBox
 * @param {import('../individual/all_events/wrapper').AllEventsBox} allEventsBox
 * @param {import('../individual/diary_most_important_info_summary/wrapper').DiarySummaryBox} diarySummaryBox
 * @returns {Array<import('../incremental_graph/types').NodeDef>}
 */
function createDefaultGraphDefinition(capabilities, configBox, allEventsBox, diarySummaryBox) {
    return [
        {
            output: "config",
            inputs: [],
            computor: config.makeComputor(configBox, capabilities),
            isDeterministic: false,
            hasSideEffects: false,
        },
        {
            output: "all_events",
            inputs: [],
            computor: allEvents.makeComputor(allEventsBox, capabilities),
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
            computor: sortedEventsDescending.computor,
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
            computor: sortedEventsAscending.computor,
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
            computor: lastEntries.computor,
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
            computor: firstEntries.computor,
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
            computor: eventsCount.computor,
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "meta_events",
            inputs: ["all_events"],
            computor: metaEvents.computor,
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "event_context",
            inputs: ["meta_events"],
            computor: eventContext.computor,
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "event(e)",
            inputs: ["all_events"],
            computor: event.computor,
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "basic_context(e)",
            inputs: ["all_events"],
            computor: basicContext.computor,
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "calories(e)",
            inputs: ["basic_context(e)"],
            computor: calories.makeComputor(capabilities),
            isDeterministic: false,
            hasSideEffects: true,
        },
        {
            output: "transcription(a)",
            inputs: [],
            computor: transcription.makeComputor(capabilities),
            isDeterministic: false,
            hasSideEffects: true,
        },
        {
            output: "event_audios_list(e)",
            inputs: ["event(e)"],
            computor: eventAudiosList.makeComputor(capabilities),
            isDeterministic: false,
            hasSideEffects: true,
        },
        {
            output: "event_transcription(e, a)",
            inputs: ["event(e)", "transcription(a)"],
            computor: eventTranscription.makeComputor(capabilities),
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "diary_most_important_info_summary",
            inputs: [],
            computor: diarySummary.makeComputor(diarySummaryBox),
            isDeterministic: false,
            hasSideEffects: false,
        },
    ];
}

module.exports = {
    createDefaultGraphDefinition,
};
