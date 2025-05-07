const path = require("path");
const os = require("os");
const logger = require("./logger");
const {
    diaryAudiosDirectory,
    eventLogDirectory,
    eventLogAssetsDirectory,
} = require("./environment");
const { transcribeAllGeneric } = require("./transcribe_all");
const { formatFileTimestamp } = require("./formatFileTimestamp");
const {
    copyFile,
    appendFile,
    writeFile,
    rename,
    unlink,
} = require("fs/promises");
const { commitDiaryChanges } = require("./diaryStorage");

/**
 * Appends an array of entries to a specified file.
 * Each entry is serialized to JSON format and appended to the file with a newline.
 *
 * @param {string} filePath - The path to the file where entries will be appended.
 * @param {Array<Object>} entries - An array of objects to append to the file.
 * @returns {Promise<void>} - A promise that resolves when all entries are appended.
 */
async function appendEntriesToFile(filePath, entries) {
    for (const entry of entries) {
        const entryString = JSON.stringify(entry, null, "\t");
        await appendFile(filePath, entryString + "\n", "utf8");
    }
}

/**
 * @param {string} originalPath
 * @param {string} resultPath
 * @returns {Promise<void>}
 */
async function copyOrTouch(originalPath, resultPath) {
    try {
        await copyFile(originalPath, resultPath);
    } catch (error) {
        if (error instanceof Error) {
            if ("code" in error && error.code === "ENOENT") {
                await writeFile(resultPath, "", "utf8");
                return;
            }
        }

        throw error;
    }
}

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
    // now update the event-log data.json
    //
    const eventLogDir = eventLogDirectory();
    const originalDataPath = path.join(eventLogDir, "data.json");
    const tempDataPath = path.join(os.tmpdir(), `data.json`);

    // try to copy the original; if missing, start with empty
    copyOrTouch(originalDataPath, tempDataPath);

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

    // append entries to the temporary file
    await appendEntriesToFile(tempDataPath, entries);

    // atomically replace original
    await rename(tempDataPath, originalDataPath);

    // Delete the original audio files.
    for (const filename of successes) {
        const inputPath = path.join(diaryAudiosDir, filename);
        await unlink(inputPath);
    }

    // Commit diary changes
    await commitDiaryChanges();
}

module.exports = { processDiaryAudios };
