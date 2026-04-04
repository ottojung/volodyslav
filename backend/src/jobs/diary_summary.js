/**
 * Diary summary pipeline.
 *
 * Iterates all diary events via the incremental graph and folds their
 * diary content (typed text and/or transcribed audio) into the rolling summary.
 * For each diary event, `Interface.isTranscribed` is checked first to avoid
 * triggering new AI transcription calls, then `Interface.entryDiaryContent`
 * is used to retrieve the combined content.
 */

const { diarySummary: aiDiarySummaryModule } = require("../ai");
const { DIARY_SUMMARY_MODEL } = aiDiarySummaryModule;
const { fromISOString } = require("../datetime");
const { makeExclusiveProcess } = require("../exclusive_process");
const { getType: getEventType } = require("../event");

/** @typedef {import('../capabilities/root').Capabilities} Capabilities */
/** @typedef {import('../generators/incremental_graph/database/types').DiaryMostImportantInfoSummaryEntry} DiaryMostImportantInfoSummaryEntry */

// ---------------------------------------------------------------------------
// Diary summary run state types
// ---------------------------------------------------------------------------

/**
 * @typedef {{ eventId: string, status: "pending" | "success" | "error" }} DiarySummaryRunEntry
 */

/**
 * @typedef {{ status: "idle" }} IdleDiarySummaryRunState
 */

/**
 * @typedef {{ status: "running", started_at: string, entries: DiarySummaryRunEntry[] }} RunningDiarySummaryRunState
 */

/**
 * @typedef {{ status: "success", started_at: string, finished_at: string, entries: DiarySummaryRunEntry[], summary: DiaryMostImportantInfoSummaryEntry }} SuccessfulDiarySummaryRunState
 */

/**
 * @typedef {{ status: "error", started_at: string, finished_at: string, entries: DiarySummaryRunEntry[], error: string }} FailedDiarySummaryRunState
 */

/**
 * @typedef {IdleDiarySummaryRunState | RunningDiarySummaryRunState | SuccessfulDiarySummaryRunState | FailedDiarySummaryRunState} DiarySummaryRunState
 */

// ---------------------------------------------------------------------------
// Exclusive process
// ---------------------------------------------------------------------------

/**
 * Argument type for `diarySummaryExclusiveProcess`.
 * `capabilities` is part of the argument so the procedure can use it directly
 * without relying on a module-level closure variable.
 *
 * @typedef {{ capabilities: Capabilities }} DiarySummaryArg
 */

/**
 * Shared ExclusiveProcess for the diary summary pipeline.
 *
 * The procedure uses `mutateState` to transition the state through:
 * `idle → running → success | error`.
 *
 * The first `mutateState` call in the procedure is synchronous, so by the time
 * `invoke` returns the state is already `"running"`.
 *
 * Both the hourly scheduled job and the POST /diary-summary/run route use this
 * instance.  A second concurrent invocation *attaches* to the already-running
 * computation — no queuing needed.
 */
const diarySummaryExclusiveProcess = makeExclusiveProcess({
    /** @type {DiarySummaryRunState} */
    initialState: { status: "idle" },
    /**
     * @param {(fn: (state: DiarySummaryRunState) => DiarySummaryRunState | Promise<DiarySummaryRunState>) => Promise<void>} mutateState
     * @param {DiarySummaryArg} arg
     * @returns {Promise<DiaryMostImportantInfoSummaryEntry>}
     */
    procedure: (mutateState, { capabilities }) => {
        const started_at = capabilities.datetime.now().toISOString();

        // Sync transformer → state updated synchronously before invoke returns.
        mutateState(() => ({
            status: "running",
            started_at,
            entries: [],
        }));

        capabilities.logger.logInfo({ started_at }, "Diary summary pipeline started in background");

        const callbacks = {
            /** @param {string} eventId */
            onEntryQueued: (eventId) => {
                mutateState((current) => {
                    if (current.status !== "running") return current;
                    return { ...current, entries: [...current.entries, { eventId, status: "pending" }] };
                });
            },
            /**
             * @param {string} eventId
             * @param {"success" | "error"} status
             */
            onEntryProcessed: (eventId, status) => {
                mutateState((current) => {
                    if (current.status !== "running") return current;
                    return {
                        ...current,
                        entries: current.entries.map((e) =>
                            e.eventId === eventId && e.status === "pending" ? { ...e, status } : e
                        ),
                    };
                });
            },
        };

        return _runDiarySummaryPipelineUnlocked(capabilities, callbacks)
            .then((summary) => {
                const finished_at = capabilities.datetime.now().toISOString();
                mutateState((current) => ({
                    status: "success",
                    started_at,
                    finished_at,
                    entries: current.status === "running" ? current.entries : [],
                    summary,
                }));
                capabilities.logger.logInfo(
                    { started_at, finished_at },
                    "Diary summary pipeline finished successfully"
                );
                return summary;
            })
            .catch((error) => {
                const finished_at = capabilities.datetime.now().toISOString();
                const errorMessage = error instanceof Error ? error.message : String(error);
                mutateState(() => ({
                    status: "error",
                    started_at,
                    finished_at,
                    entries: [],
                    error: errorMessage,
                }));
                capabilities.logger.logError({ error, errorMessage }, "Diary summary pipeline failed");
                throw error;
            });
    },
    // All concurrent calls attach to the same run — no queuing needed.
    conflictor: () => "attach",
});

/**
 * Runs the diary summary pipeline.
 *
 * Uses a shared ExclusiveProcess so that a second concurrent invocation attaches
 * to the already-running computation instead of starting a new one.  Any error
 * propagates to all callers.
 *
 * @param {Capabilities} capabilities
 * @returns {Promise<DiaryMostImportantInfoSummaryEntry>}
 */
function runDiarySummaryPipeline(capabilities) {
    return diarySummaryExclusiveProcess.invoke({ capabilities }).result;
}

/**
 * Internal (unlocked) implementation of the pipeline.
 * @param {Capabilities} capabilities
 * @param {{ onEntryQueued?: (eventId: string) => void, onEntryProcessed?: (eventId: string, status: "success" | "error") => void }} [callbacks]
 * @returns {Promise<DiaryMostImportantInfoSummaryEntry>}
 */
async function _runDiarySummaryPipelineUnlocked(capabilities, callbacks) {
    await capabilities.interface.ensureInitialized();

    const currentSummary = await capabilities.interface.getDiarySummary();

    let currentMarkdown = currentSummary.markdown;
    let currentSummaryDate = currentSummary.summaryDate;
    /** @type {Record<string, string>} */
    const processedEntries = { ...currentSummary.processedEntries };

    let hasUpdates = false;

    for await (const event of capabilities.interface.getSortedEvents("dateAscending")) {
        if (getEventType(event) !== "diary") {
            continue;
        }

        const eventId = event.id.identifier;

        // Skip events whose audio has not yet been transcribed to avoid triggering
        // new AI transcription calls. Entries with no audio always pass this gate.
        const isTranscribed = await capabilities.interface.isTranscribed(eventId);
        if (!isTranscribed) {
            continue;
        }

        // Check if this entry has already been processed (watermark by event ID).
        const lastProcessedTimestamp = processedEntries[eventId];
        const newEntryDateISO = event.date.toISOString();
        if (lastProcessedTimestamp !== undefined && lastProcessedTimestamp >= newEntryDateISO) {
            continue;
        }

        // Pull the combined diary content (typed text + transcribed audio).
        let typedText;
        let transcribedAudioRecording;
        try {
            const content = await capabilities.interface.entryDiaryContent(eventId);
            typedText = content.typedText;
            transcribedAudioRecording = content.transcribedAudioRecording;
        } catch (error) {
            capabilities.logger.logError(
                { eventId, error },
                "Diary summary pipeline: failed to pull entry diary content",
            );
            continue;
        }

        if (!typedText && !transcribedAudioRecording) {
            continue;
        }

        // Signal that this entry is about to be processed.
        callbacks?.onEntryQueued?.(eventId);

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
            processedEntries[eventId] = newEntryDateISO;

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
                { eventId, newEntryDateISO },
                "Diary summary updated with new diary content"
            );

            // Persist incrementally so a crash mid-run loses at most one fold.
            /** @type {DiaryMostImportantInfoSummaryEntry} */
            const intermediateSummary = {
                type: "diary_most_important_info_summary",
                markdown: currentMarkdown,
                summaryDate: currentSummaryDate,
                processedEntries: { ...processedEntries },
                updatedAt: capabilities.datetime.now().toISOString(),
                model: DIARY_SUMMARY_MODEL,
                version: "1",
            };
            await capabilities.interface.setDiarySummary(intermediateSummary);

            callbacks?.onEntryProcessed?.(eventId, "success");
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            capabilities.logger.logError(
                { eventId, error, errorMessage },
                "Error updating diary summary for diary content entry"
            );
            callbacks?.onEntryProcessed?.(eventId, "error");
            // Continue to the next entry rather than aborting the pipeline.
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
