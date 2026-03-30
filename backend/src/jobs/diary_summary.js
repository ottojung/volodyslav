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

/** @typedef {import('../capabilities/root').Capabilities} Capabilities */
/** @typedef {import('../generators/incremental_graph/database/types').DiaryMostImportantInfoSummaryEntry} DiaryMostImportantInfoSummaryEntry */

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".opus", ".weba"]);

/**
 * @param {string} filename
 * @returns {boolean}
 */
function isAudioFilename(filename) {
    const basename = path.basename(filename).toLocaleLowerCase();
    if (basename === "diary-audio.webm") {
        return true;
    }
    if (AUDIO_EXTENSIONS.has(path.extname(filename).toLowerCase())) {
        return true;
    }
    return false;
}

/**
 * Computes the assets directory path for a given event.
 * @param {string} assetsDir
 * @param {import('../event/structure').Event} event
 * @returns {string}
 */
function eventAssetsDir(assetsDir, event) {
    const date = event.date;
    const year = date.year;
    const month = String(date.month).padStart(2, "0");
    const day = String(date.day).padStart(2, "0");
    return path.join(assetsDir, `${year}-${month}`, day, event.id.identifier);
}

/**
 * Runs the diary summary pipeline.
 *
 * Steps:
 *  1. Read current summary from graph.
 *  2. Iterate all events in ascending date order.
 *  3. For each event, scan its audio assets and look for materialized transcriptions
 *     whose graph-node modification time is newer than the recorded watermark.
 *  4. For each new transcription, call the AI summarizer and advance the watermarks.
 *  5. Write the updated summary back to the graph.
 *
 * @param {Capabilities} capabilities
 * @returns {Promise<DiaryMostImportantInfoSummaryEntry>}
 */
async function runDiarySummaryPipeline(capabilities) {
    await capabilities.interface.ensureInitialized();

    const currentSummary = await capabilities.interface.getDiarySummary();

    const assetsDir = capabilities.environment.eventLogAssetsDirectory();

    let currentMarkdown = currentSummary.markdown;
    let currentSummaryDate = currentSummary.summaryDate;
    /** @type {Record<string, string>} */
    const processedTranscriptions = { ...currentSummary.processedTranscriptions };

    let hasUpdates = false;

    for await (const event of capabilities.interface.getSortedEvents("dateAscending")) {
        const dirPath = eventAssetsDir(assetsDir, event);

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

                // Advance summaryDate to max(summaryDate, newEntryDateISO).
                if (!currentSummaryDate || newEntryDateISO > currentSummaryDate) {
                    currentSummaryDate = newEntryDateISO;
                }

                hasUpdates = true;

                capabilities.logger.logInfo(
                    { relativeAssetPath, newEntryDateISO },
                    "Diary summary updated with new transcription"
                );
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                capabilities.logger.logError(
                    { relativeAssetPath, error: msg },
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

    /** @type {DiaryMostImportantInfoSummaryEntry} */
    const newSummary = {
        type: "diary_most_important_info_summary",
        markdown: currentMarkdown,
        summaryDate: currentSummaryDate,
        processedTranscriptions,
        updatedAt: capabilities.datetime.now().toISOString(),
        model: DIARY_SUMMARY_MODEL,
        version: "1",
    };

    await capabilities.interface.setDiarySummary(newSummary);

    capabilities.logger.logInfo(
        { summaryDate: newSummary.summaryDate, updatedAt: newSummary.updatedAt },
        "Diary summary pipeline complete"
    );

    return newSummary;
}

module.exports = {
    runDiarySummaryPipeline,
};
