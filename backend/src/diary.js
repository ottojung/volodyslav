const path = require("path");
const { logError, logWarning } = require("./logger");
const {
    diaryAudiosDirectory,
    eventLogAssetsDirectory,
} = require("./environment");
const { transcribeAllGeneric } = require("./transcribe_all");
const { formatFileTimestamp } = require("./format_time_stamp");
const { copyFile, unlink, mkdir, access } = require("fs/promises");
const { transaction } = require("./event_log_storage");
const eventId = require("./event/id");

/**
 * @param {string} filename
 * @returns {Date}
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
    const ret = path.join(eventLogAssetsDirectory(), date.toISOString());
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
 * Ensures target directory exists, warns on existing file, then copies the file.
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {Promise<void>}
 * @throws {Error} If the copy operation fails.
 */
async function copyWithOverwrite(inputPath, outputPath) {
    const targetDir = path.dirname(outputPath);
    await mkdir(targetDir, { recursive: true });
    try {
        await access(outputPath);
        logWarning({ file: outputPath }, `Overwriting existing file`);
    } catch {
        // file does not exist, proceed
    }
    await copyFile(inputPath, outputPath);
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
 *
 * @param {import('./random').RNG} rng - A random number generator instance.
 * @returns {Promise<void>} - A promise that resolves when all processing is complete.
 */
async function processDiaryAudios(rng) {
    const diaryAudiosDir = diaryAudiosDirectory();
    const transcriptionResults = await transcribeAllGeneric(
        diaryAudiosDir,
        namer
    );

    const successes = transcriptionResults.successes;
    const failures = transcriptionResults.failures;

    failures.forEach((failure) => {
        logError(
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
        await copyWithOverwrite(inputPath, targetPath);
    }

    //
    // now update the event-log storage.
    //
    await writeChanges(rng, successes);

    // Delete the original audio files.
    for (const filename of successes) {
        const inputPath = path.join(diaryAudiosDir, filename);
        await unlink(inputPath);
    }
}

/**
 * Writes changes to the event log by appending entries for successfully
 * transcribed diary audio files.
 * @param {import('./random').RNG} rng - A random number generator instance.
 * @param {Array<string>} successes - An array of successfully transcribed filenames.
 * @returns {Promise<void>} - A promise that resolves when the changes are written.
 */
async function writeChanges(rng, successes) {
    // prepare entries to append
    const entries = successes.map((filename) => {
        const date = filename_to_date(filename);
        const id = eventId.make(rng);

        /** @type {import('./event/structure').Event} */
        const ret = {
            id,
            date,
            original: `diary [when 0 hours ago]`,
            input: `diary [when 0 hours ago]`,
            modifiers: {
                when: "0 hours ago",
            },
            type: "diary",
            description: "",
        };
        return ret;
    });

    /**
     * @type {import('./event_log_storage').EventLogStorage}
     */
    await transaction(async (eventLogStorage) => {
        for (const entry of entries) {
            eventLogStorage.addEntry(entry, []);
        }
    });
}

module.exports = { processDiaryAudios };
