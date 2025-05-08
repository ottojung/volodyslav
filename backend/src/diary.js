const path = require("path");
const logger = require("./logger");
const {
    diaryAudiosDirectory,
    eventLogAssetsDirectory,
} = require("./environment");
const { transcribeAllGeneric } = require("./transcribe_all");
const { formatFileTimestamp } = require("./format_time_stamp");
const {
    copyFile,
    unlink,
} = require("fs/promises");
const { transaction } = require("./event_log_storage");

/**
 * @param {string} filename
 * @returns {string}
 */
function filename_to_date(filename) {
    return formatFileTimestamp(filename);
}

/**
 * @param {string} filename
 * @returns {string}
 */
function assets_directory(filename) {
    const date = filename_to_date(filename);
    const ret = path.join(eventLogAssetsDirectory(), date);
    return ret;
}

/**
 * @param {string} filename
 * @returns {string}
 */
function namer(filename) {
    const targetDir = assets_directory(filename);
    const targetName = `transcription.json`;
    return path.join(targetDir, targetName);
}

/**
 * Processes diary audio files by transcribing them, organizing the results,
 * updating the event log, cleaning up the original files, and committing changes.
 *
 * This function performs the following steps:
 * 1. Transcribes all audio files in the diary audios directory.
 * 2. Copies successfully transcribed files to a target directory.
 * 3. Updates the event log with new entries for the transcriptions.
 * 4. Deletes the original audio files after processing.
 * 5. Commits the diary changes.
 *
 * @returns {Promise<void>} - A promise that resolves when all processing is complete.
 */
async function processDiaryAudios() {
    const diaryAudiosDir = diaryAudiosDirectory();
    const transcriptionResults = await transcribeAllGeneric(
        diaryAudiosDir,
        namer
    );

    const successes = transcriptionResults.successes;
    const failures = transcriptionResults.failures;

    failures.forEach((failure) => {
        logger.error(
            {
                file: failure.file,
                error: failure.message,
                directory: diaryAudiosDir,
            },
            `Diary audio transcription failed: ${failure.message}`
        );
    });

    for (const filename of successes) {
        const inputPath = path.join(diaryAudiosDir, filename);
        const targetDir = assets_directory(filename);
        const targetPath = path.join(targetDir, filename);
        await copyFile(inputPath, targetPath);
    }

    //
    // now update the event-log storage.
    //
    writeChanges(successes);

    // Delete the original audio files.
    for (const filename of successes) {
        const inputPath = path.join(diaryAudiosDir, filename);
        await unlink(inputPath);
    }
}

/**
 * Writes changes to the event log by appending entries for successfully
 * transcribed diary audio files.
 * @param {Array<string>} successes - An array of successfully transcribed filenames.
 * @returns {Promise<void>} - A promise that resolves when the changes are written.
 */
async function writeChanges(successes) {
    // prepare entries to append
    const entries = successes.map((filename) => {
        const dateStr = filename_to_date(filename);

        return {
            date: dateStr,
            original: `diary [when 0 hours ago]`,
            input: `diary [when 0 hours ago]`,
            modifiers: {
                when: "0 hours ago",
            },
            type: "diary",
            description: "",
        };
    });

    /**
     * @type {import('./event_log_storage').EventLogStorage}
     */
    await transaction((eventLogStorage) => {
        entries.forEach(eventLogStorage.addEntry);
    });
}

module.exports = { processDiaryAudios };
