const path = require("path");
const { readdir } = require("fs/promises");
const { formatFileTimestamp } = require("./format_time_stamp");
const { logError, logWarning, logInfo } = require("./logger");
const { diaryAudiosDirectory } = require("./environment");
const { transaction } = require("./event_log_storage");
const eventId = require("./event/id");
const asset = require("./event/asset");

/** @typedef {import('./event/asset').Asset} Asset */
/** @typedef {import('./filesystem/delete_file').FileDeleter} FileDeleter */
/** @typedef {import('./random').RNG} RNG */

/**
 * Processes diary audio files by copying assets, updating the event log,
 * and cleaning up the originals.
 *
 * @param {FileDeleter} deleter - A file deleter instance.
 * @param {RNG} rng - A random number generator instance.
 * @returns {Promise<void>} - A promise that resolves when processing is complete.
 */
async function processDiaryAudios(deleter, rng) {
    const diaryAudiosDir = diaryAudiosDirectory();
    const inputFiles = await readdir(diaryAudiosDir);

    // prepare assets.
    const assets = inputFiles.map((filename) => {
        const filepath = path.join(diaryAudiosDir, filename);
        const date = formatFileTimestamp(filename);
        const id = eventId.make(rng);

        /** @type {import('./event/structure').Event} */
        const event = {
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

        const ass = asset.make(event, filepath);
        return ass;
    });

    const successes = [];
    const failures = [];

    // now update the event-log storage.
    for (const ass of assets) {
        try {
            await writeAsset(deleter, ass);
            successes.push(ass);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            failures.push({ file: path.basename(ass.filepath), message });
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
    await deleteOriginalAudios(deleter, successes, diaryAudiosDir);
}

/**
 * Writes changes to the event log by appending entries for successfully
 * transcribed diary audio files.
 * @param {FileDeleter} deleter - A file deleter instance.
 * @param {Asset} ass - An array of TranscriptionSuccess objects.
 * @returns {Promise<void>} - A promise that resolves when the changes are written.
 */
async function writeAsset(deleter, ass) {
    await transaction(deleter, async (eventLogStorage) => {
        eventLogStorage.addEntry(ass.event, [ass]);
    });
}

/**
 * Deletes original diary audio files and logs outcomes.
 *
 * @param {FileDeleter} deleter
 * @param {Asset[]} successes
 * @param {string} diaryAudiosDir
 */
async function deleteOriginalAudios(deleter, successes, diaryAudiosDir) {
    for (const ass of successes) {
        try {
            await deleter.delete(ass.filepath);
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
