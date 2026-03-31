/**
 * Diary summary pipeline.
 *
 * Iterates all diary events via the incremental graph and folds their materialized
 * diary content (typed text and/or transcribed audio) into the rolling summary.
 * The list of audio files for each event is obtained by pulling the
 * `event_audios_list(e)` graph node — no direct filesystem access occurs in this
 * module.
 */

const { diarySummary: aiDiarySummaryModule } = require("../ai");
const { DIARY_SUMMARY_MODEL } = aiDiarySummaryModule;
const { fromISOString } = require("../datetime");
const { makeExclusiveProcess } = require("../exclusive_process");
const { getType: getEventType } = require("../event");

/** @typedef {import('../capabilities/root').Capabilities} Capabilities */
/** @typedef {import('../generators/incremental_graph/database/types').DiaryMostImportantInfoSummaryEntry} DiaryMostImportantInfoSummaryEntry */

/**
 * @callback OnEntryQueued
 * @param {string} path - The relative asset path of the entry that will be processed.
 * @returns {void}
 */

/**
 * @callback OnEntryProcessed
 * @param {string} path - The relative asset path of the entry that was processed.
 * @param {"success" | "error"} status - The outcome.
 * @returns {void}
 */

/**
 * @typedef {object} DiarySummaryPipelineCallbacks
 * @property {OnEntryQueued} [onEntryQueued] - Called when an entry is determined to need processing.
 * @property {OnEntryProcessed} [onEntryProcessed] - Called after each entry is processed.
 */

/**
 * Singleton ExclusiveProcess for the diary summary pipeline.
 *
 * Both the hourly scheduled job and the POST /diary-summary/run route use this
 * instance.  A second concurrent invocation *attaches* to the already-running
 * computation instead of starting a new one.
 *
 * Callbacks from all concurrent callers (initiator + every attacher) are
 * collected into a per-run fan-out set so that every caller receives
 * onEntryQueued / onEntryProcessed notifications for the entire run,
 * regardless of whether the run was started by the caller or was already
 * under way when the caller joined.
 */
const diarySummaryExclusiveProcess = (() => {
    /** @type {DiarySummaryPipelineCallbacks[]} */
    let subscriberCallbacks = [];

    /**
     * The fixed procedure.  Receives only `capabilities`; callbacks are taken
     * from the shared `subscriberCallbacks` list so that future attachers can
     * be added to it after the run has started.
     *
     * @param {Capabilities} capabilities
     * @returns {Promise<DiaryMostImportantInfoSummaryEntry>}
     */
    function procedure(capabilities) {
        /** @type {DiarySummaryPipelineCallbacks} */
        const fanOut = {
            onEntryQueued: (path) => {
                for (const cb of subscriberCallbacks) cb.onEntryQueued?.(path);
            },
            onEntryProcessed: (path, status) => {
                for (const cb of subscriberCallbacks) cb.onEntryProcessed?.(path, status);
            },
        };
        return _runDiarySummaryPipelineUnlocked(capabilities, fanOut);
    }

    const base = makeExclusiveProcess(procedure);

    return {
        /**
         * Start or attach to the diary summary pipeline.
         *
         * - If idle: starts a new run and registers `callbacks` as the first
         *   subscriber in the fan-out set.
         * - If running: registers `callbacks` in the fan-out set so future
         *   events are forwarded, then returns an attacher handle backed by
         *   the current run's shared promise.
         *
         * @param {Capabilities} capabilities
         * @param {DiarySummaryPipelineCallbacks} [callbacks]
         * @returns {import('../exclusive_process').ExclusiveProcessHandleClass<DiaryMostImportantInfoSummaryEntry>}
         */
        invoke(capabilities, callbacks) {
            if (base.isRunning()) {
                if (callbacks) {
                    subscriberCallbacks.push(callbacks);
                }
            } else {
                subscriberCallbacks = callbacks ? [callbacks] : [];
            }
            return base.invoke([capabilities]);
        },

        /**
         * Returns `true` if the pipeline is currently running.
         * @returns {boolean}
         */
        isRunning() {
            return base.isRunning();
        },
    };
})();

/**
 * Runs the diary summary pipeline.
 *
 * Steps:
 *  1. Read current summary from graph.
 *  2. Iterate all diary events in ascending date order.
 *  3. For each event, pull `event_audios_list(e)` from the graph to get its audio paths.
 *  4. For each audio path, check whether an `entry_diary_content(e, a)` graph node has been materialized.
 *  5. For each new diary content entry, call the AI summarizer and advance the watermarks.
 *  6. Persist the updated summary back to the graph after each fold.
 *
 * Uses a shared ExclusiveProcess singleton so that a second concurrent
 * invocation attaches to the already-running computation instead of starting
 * a new one.  Callbacks are forwarded to all concurrent callers.  Any error
 * propagates to all callers.
 *
 * @param {Capabilities} capabilities
 * @param {DiarySummaryPipelineCallbacks} [callbacks]
 * @returns {Promise<DiaryMostImportantInfoSummaryEntry>}
 */
function runDiarySummaryPipeline(capabilities, callbacks) {
    return diarySummaryExclusiveProcess.invoke(capabilities, callbacks).result;
}

/**
 * Internal (unlocked) implementation of the pipeline.
 * @param {Capabilities} capabilities
 * @param {DiarySummaryPipelineCallbacks} [callbacks]
 * @returns {Promise<DiaryMostImportantInfoSummaryEntry>}
 */
async function _runDiarySummaryPipelineUnlocked(capabilities, callbacks) {
    await capabilities.interface.ensureInitialized();

    const currentSummary = await capabilities.interface.getDiarySummary();

    let currentMarkdown = currentSummary.markdown;
    let currentSummaryDate = currentSummary.summaryDate;
    /** @type {Record<string, string>} */
    const processedTranscriptions = { ...currentSummary.processedTranscriptions };

    let hasUpdates = false;

    for await (const event of capabilities.interface.getSortedEvents("dateAscending")) {
        if (getEventType(event) !== "diary") {
            continue;
        }

        const eventId = event.id.identifier;

        // Pull the audio list from the graph — no filesystem access here.
        let audioListEntry;
        try {
            audioListEntry = await capabilities.interface.pullGraphNode(
                "event_audios_list",
                [eventId],
            );
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            capabilities.logger.logError(
                { eventId, error, errorMessage },
                "Diary summary pipeline: failed to pull event_audios_list",
            );
            continue;
        }

        if (audioListEntry.type !== "event_audios_list") {
            capabilities.logger.logError(
                { eventId, actualType: audioListEntry.type },
                "Diary summary pipeline: unexpected node type from event_audios_list pull",
            );
            continue;
        }

        for (const relativeAssetPath of audioListEntry.audioPaths) {
            // Gate on transcription(a) materialization to avoid triggering
            // new AI transcription calls for un-transcribed audio.
            const transcriptionFreshness = await capabilities.interface.debugGetFreshness(
                "transcription",
                [relativeAssetPath]
            );
            if (transcriptionFreshness === "missing") {
                continue;
            }

            // Check if this entry has already been processed.
            // NOTE: `processedTranscriptions` is a legacy field name; it actually
            // tracks the last-processed modification time of entry_diary_content nodes
            // (keyed by the transcription asset path for backwards-compatible storage).
            const lastProcessedDiaryContent = processedTranscriptions[relativeAssetPath];
            // Get the event date as an ISO string for context.
            const newEntryDateISO = event.date.toISOString();
            if (lastProcessedDiaryContent !== undefined && lastProcessedDiaryContent >= newEntryDateISO) {
                continue;
            }

            // Pull entry_diary_content unconditionally — this triggers its computation
            // from the already-cached transcription(a) value without triggering new AI calls.
            let diaryContentValue;
            try {
                const diaryContentEntry = await capabilities.interface.pullGraphNode(
                    "entry_diary_content",
                    [eventId, relativeAssetPath]
                );
                if (diaryContentEntry.type !== "entry_diary_content") {
                    continue;
                }
                if (diaryContentEntry.value === "N/A") {
                    continue;
                }
                diaryContentValue = diaryContentEntry.value;
            } catch (error) {
                capabilities.logger.logError(
                    { eventId, relativeAssetPath, error },
                    "Diary summary pipeline: failed to pull entry_diary_content",
                );
                continue;
            }

            const { typedText, transcribedAudioRecording } = diaryContentValue;

            if (!typedText && !transcribedAudioRecording) {
                continue;
            }

            // Signal that this entry is about to be processed.
            callbacks?.onEntryQueued?.(relativeAssetPath);

            // Call the AI summarizer.
            try {
                const result = await capabilities.aiDiarySummary.updateSummary({
                    currentSummaryMarkdown: currentMarkdown,
                    newEntryTypedText: typedText,
                    newEntryTranscribedAudioRecording: transcribedAudioRecording,
                    currentSummaryDateISO: currentSummaryDate,
                    newEntryDateISO,
                });

                currentMarkdown = result.summaryMarkdown;
                processedTranscriptions[relativeAssetPath] = newEntryDateISO;

                // Advance summaryDate to max(summaryDate, newEntryDateISO) using
                // DateTime comparison to handle mixed timezone offsets correctly.
                const newEntryTime = fromISOString(newEntryDateISO);
                const shouldAdvance = !currentSummaryDate ||
                    newEntryTime.isAfter(fromISOString(currentSummaryDate));
                if (shouldAdvance) {
                    currentSummaryDate = newEntryDateISO;
                }

                hasUpdates = true;

                capabilities.logger.logInfo(
                    { relativeAssetPath, newEntryDateISO },
                    "Diary summary updated with new diary content"
                );

                // Persist incrementally so a crash mid-run loses at most one fold.
                /** @type {DiaryMostImportantInfoSummaryEntry} */
                const intermediateSummary = {
                    type: "diary_most_important_info_summary",
                    markdown: currentMarkdown,
                    summaryDate: currentSummaryDate,
                    processedTranscriptions: { ...processedTranscriptions },
                    updatedAt: capabilities.datetime.now().toISOString(),
                    model: DIARY_SUMMARY_MODEL,
                    version: "1",
                };
                await capabilities.interface.setDiarySummary(intermediateSummary);

                callbacks?.onEntryProcessed?.(relativeAssetPath, "success");
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                capabilities.logger.logError(
                    { relativeAssetPath, error, errorMessage },
                    "Error updating diary summary for diary content entry"
                );
                callbacks?.onEntryProcessed?.(relativeAssetPath, "error");
                // Continue to the next transcription rather than aborting the pipeline.
            }
        }
    }

    if (!hasUpdates) {
        capabilities.logger.logDebug({}, "Diary summary pipeline: no new diary content to process");
        return currentSummary;
    }

    // The final state was already persisted incrementally after each fold.
    // Re-read from the graph to return the authoritative persisted value.
    const finalSummary = await capabilities.interface.getDiarySummary();

    capabilities.logger.logInfo(
        { summaryDate: finalSummary.summaryDate, updatedAt: finalSummary.updatedAt },
        "Diary summary pipeline complete"
    );

    return finalSummary;
}

module.exports = {
    runDiarySummaryPipeline,
    diarySummaryExclusiveProcess,
};

