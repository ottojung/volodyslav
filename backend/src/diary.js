const path = require("path");
const { readdir } = require("fs/promises");
const { formatFileTimestamp } = require("./format_time_stamp");
const { logError, logWarning, logInfo } = require("./logger");
const { diaryAudiosDirectory } = require("./environment");
const { transaction } = require("./event_log_storage");
const eventId = require("./event/id");
const asset = require("./event/asset");
const creatorMake = require("./creator");

/** @typedef {import('./event/asset').Asset} Asset */
/** @typedef {import('./filesystem/delete_file').FileDeleter} FileDeleter */
/** @typedef {import('./random').RNG} RNG */

/**
 * @typedef {object} Capabilities
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {RNG} rng - A random number generator instance.
 */

/**
 * Processes diary audio files by copying assets, updating the event log,
 * and cleaning up the originals.
 *
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @returns {Promise<void>} - A promise that resolves when processing is complete.
 */
async function processDiaryAudios(capabilities) {
    const diaryAudiosDir = diaryAudiosDirectory();
    const inputFiles = await readdir(diaryAudiosDir);
    const creator = await creatorMake();

    /**
     * @param {string} filename
     * @returns {Asset}
     */
    function makeAsset(filename) {
        const filepath = path.join(diaryAudiosDir, filename);
        const date = formatFileTimestamp(filename);
        const id = eventId.make(capabilities);

        /** @type {import('./event/structure').Event} */
        const event = {
            id,
            date,
            original: `diary [when 0 hours ago] [audiorecording]`,
            input: `diary [when 0 hours ago] [audiorecording]`,
            modifiers: {
                when: "0 hours ago",
                audiorecording: "",
            },
            type: "diary",
            description: "",
            creator,
        };

        const ass = asset.make(event, filepath);
        return ass;
    }

    const successes = [];
    const failures = [];

    // now update the event-log storage.
    for (const filename of inputFiles) {
        try {
            const ass = makeAsset(filename);
            await writeAsset(capabilities, ass);
            successes.push(ass);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            failures.push({ file: filename, message });
        }
    }

    successes.forEach((ass) => {
        const filename = path.basename(ass.filepath);
        logInfo(
            { filename },
            `Diary audio ${JSON.stringify(filename)} processed`
        );
    });

    failures.forEach((failure) => {
        logError(
            {
                file: failure.file,
                error: failure.message,
                directory: diaryAudiosDir,
            },
            `Diary audio copy failed: ${failure.message}`
        );
    });

    // Delete the original audio files.
    await deleteOriginalAudios(capabilities, successes, diaryAudiosDir);
}

/**
 * Writes changes to the event log by appending entries for successfully
 * transcribed diary audio files.
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {Asset} ass - An array of TranscriptionSuccess objects.
 * @returns {Promise<void>} - A promise that resolves when the changes are written.
 */
async function writeAsset(capabilities, ass) {
    await transaction(capabilities, async (eventLogStorage) => {
        eventLogStorage.addEntry(ass.event, [ass]);
    });
}

/**
 * Deletes original diary audio files and logs outcomes.
 *
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {Asset[]} successes - An array of successfully processed assets.
 * @param {string} diaryAudiosDir - The directory containing the diary audio files.
 */
async function deleteOriginalAudios(capabilities, successes, diaryAudiosDir) {
    for (const ass of successes) {
        try {
            await capabilities.deleter.deleteFile(ass.filepath);
            logInfo(
                {
                    file: path.basename(ass.filepath),
                    directory: diaryAudiosDir,
                },
                `Deleted diary audio file: ${path.basename(ass.filepath)}`
            );
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logWarning(
                {
                    file: path.basename(ass.filepath),
                    error: msg,
                    directory: diaryAudiosDir,
                },
                `Failed to delete diary audio file: ${msg}`
            );
        }
    }
}

// export remains unchanged
module.exports = { processDiaryAudios };
