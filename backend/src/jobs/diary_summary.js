/**
 * Diary summary pipeline.
 *
 * Scans all events for materialized transcriptions that have not yet been incorporated
 * into the summary. For each new transcription (in ascending date order), calls the AI
 * summarizer to update the rolling diary summary. Writes the updated summary back to the
 * incremental graph so it survives restarts.
 */

const path = require("path");
const { diarySummary: aiDiarySummaryModule } = require("../ai");
const { DIARY_SUMMARY_MODEL } = aiDiarySummaryModule;
const { fromISOString } = require("../datetime");
const { makeUniqueFunctor } = require("../unique_functor");
const { asset: eventAsset, getType: getEventType } = require("../event");

/** @typedef {import('../capabilities/root').Capabilities} Capabilities */
/** @typedef {import('../generators/incremental_graph/database/types').DiaryMostImportantInfoSummaryEntry} DiaryMostImportantInfoSummaryEntry */

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".opus", ".weba"]);

/**
 * Mutex key for serializing concurrent diary summary pipeline runs.
 * Prevents the hourly job and POST /diary-summary/run from racing.
 */
const DIARY_SUMMARY_MUTEX_KEY = makeUniqueFunctor("diary-summary-pipeline").instantiate([]);

/**
 * @param {string} filename
 * @returns {boolean}
 */
function isAudioFilename(filename) {
    const basename = path.basename(filename).toLowerCase();
    if (basename === "diary-audio.webm") {
        return true;
    }
    if (AUDIO_EXTENSIONS.has(path.extname(filename).toLowerCase())) {
        return true;
    }
    return false;
}

/**
 * Runs the diary summary pipeline.
 *
 * Steps:
 *  1. Read current summary from graph.
 *  2. Iterate all diary events in ascending date order.
 *  3. For each event, scan its audio assets and look for materialized transcriptions
 *     whose graph-node modification time is newer than the recorded watermark.
 *  4. For each new transcription, call the AI summarizer and advance the watermarks.
 *  5. Write the updated summary back to the graph after each fold.
 *
 * Runs are serialized with a mutex so the hourly job and an explicit POST run
 * cannot race and overwrite each other.
 *
 * @param {Capabilities} capabilities
 * @returns {Promise<DiaryMostImportantInfoSummaryEntry>}
 */
async function runDiarySummaryPipeline(capabilities) {
    return capabilities.sleeper.withMutex(DIARY_SUMMARY_MUTEX_KEY, () =>
        _runDiarySummaryPipelineUnlocked(capabilities)
    );
}

/**
 * Internal (unlocked) implementation of the pipeline.
 * @param {Capabilities} capabilities
 * @returns {Promise<DiaryMostImportantInfoSummaryEntry>}
 */
async function _runDiarySummaryPipelineUnlocked(capabilities) {
    await capabilities.interface.ensureInitialized();

    const currentSummary = await capabilities.interface.getDiarySummary();

    const assetsDir = capabilities.environment.eventLogAssetsDirectory();

    let currentMarkdown = currentSummary.markdown;
    let currentSummaryDate = currentSummary.summaryDate;
    /** @type {Record<string, string>} */
    const processedTranscriptions = { ...currentSummary.processedTranscriptions };

    let hasUpdates = false;

    for await (const event of capabilities.interface.getSortedEvents("dateAscending")) {
        if (getEventType(event) !== "diary") {
            continue;
        }

        const dirPath = eventAsset.targetDir(capabilities, event);

        const dirProof = await capabilities.checker.directoryExists(dirPath);
        if (dirProof === null) {
            continue;
        }

        let files;
        try {
            files = await capabilities.scanner.scanDirectory(dirPath);
        } catch {
            continue;
        }

        for (const file of files) {
            const filename = path.basename(file.path);
            if (!isAudioFilename(filename)) {
                continue;
            }

            const relativeAssetPath = path.relative(assetsDir, file.path);

            // Check if a transcription has been materialized for this asset.
            const freshness = await capabilities.interface.debugGetFreshness(
                "transcription",
                [relativeAssetPath]
            );
            if (freshness === "missing") {
                continue;
            }

            // Get the modification time of the transcription graph node.
            let modTimeISO;
            try {
                const modTime = await capabilities.interface.getModificationTime(
                    "transcription",
                    [relativeAssetPath]
                );
                modTimeISO = modTime.toISOString();
            } catch {
                continue;
            }

            // Check if this transcription has already been processed.
            const lastProcessed = processedTranscriptions[relativeAssetPath];
            if (lastProcessed !== undefined && lastProcessed >= modTimeISO) {
                continue;
            }

            // Read the transcription value.
            let transcriptionText;
            try {
                const transcriptionEntry = await capabilities.interface.pullGraphNode(
                    "transcription",
                    [relativeAssetPath]
                );
                if (transcriptionEntry.type !== "transcription") {
                    continue;
                }
                if ("message" in transcriptionEntry.value) {
                    // Skip failed transcriptions.
                    continue;
                }
                transcriptionText = transcriptionEntry.value.text;
            } catch {
                continue;
            }

            if (!transcriptionText || transcriptionText.trim() === "") {
                continue;
            }

            // Get the event date as an ISO string for context.
            const newEntryDateISO = event.date.toISOString();

            // Call the AI summarizer.
            try {
                const result = await capabilities.aiDiarySummary.updateSummary({
                    currentSummaryMarkdown: currentMarkdown,
                    newEntryTranscriptionText: transcriptionText,
                    currentSummaryDateISO: currentSummaryDate,
                    newEntryDateISO,
                });

                currentMarkdown = result.summaryMarkdown;
                processedTranscriptions[relativeAssetPath] = modTimeISO;

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
                    "Diary summary updated with new transcription"
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
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                capabilities.logger.logError(
                    { relativeAssetPath, error, errorMessage },
                    "Error updating diary summary for transcription"
                );
                // Continue to the next transcription rather than aborting the pipeline.
            }
        }
    }

    if (!hasUpdates) {
        capabilities.logger.logDebug({}, "Diary summary pipeline: no new transcriptions to process");
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
};
