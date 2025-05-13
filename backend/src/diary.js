const path = require("path");
const { readdir, copyFile, mkdir } = require("fs/promises");
const { formatFileTimestamp } = require("./format_time_stamp");
const { logError } = require("./logger");
const {
    diaryAudiosDirectory,
    eventLogAssetsDirectory,
} = require("./environment");
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
 * Ensures target directory exists, warns on existing file, then copies the file.
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {Promise<void>}
 * @throws {Error} If the copy operation fails.
 */
async function copyWithOverwrite(inputPath, outputPath) {
    const targetDir = path.dirname(outputPath);
    await mkdir(targetDir, { recursive: true });
    await copyFile(inputPath, outputPath);
}

/**
 * Processes diary audio files by copying assets, updating the event log,
 * and cleaning up the originals.
 *
 * @param {import('./filesystem/delete_file').FileDeleter} deleter - A file deleter instance.
 * @param {import('./random').RNG} rng - A random number generator instance.
 * @returns {Promise<void>} - A promise that resolves when processing is complete.
 */
async function processDiaryAudios(deleter, rng) {
    const diaryAudiosDir = diaryAudiosDirectory();
    const entries = await readdir(diaryAudiosDir);

    const successes = [];
    const failures = [];
    for (const filename of entries) {
        const inputPath = path.join(diaryAudiosDir, filename);
        const targetDir = assets_directory(filename);
        const targetPath = path.join(targetDir, filename);
        try {
            await copyWithOverwrite(inputPath, targetPath);
            successes.push({ source: inputPath, target: targetPath });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            failures.push({ file: filename, message });
        }
    }

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

    // now update the event-log storage.
    await writeChanges(deleter, rng, successes);

    // Delete the original audio files.
    for (const { source } of successes) {
        await deleter.delete(source);
    }
}

/**
 * Writes changes to the event log by appending entries for successfully
 * transcribed diary audio files.
 * @param {import('./filesystem/delete_file').FileDeleter} deleter - A file deleter instance.
 * @param {import('./random').RNG} rng - A random number generator instance.
 * @param {Array<{ source: string, target: string }>} successes - An array of TranscriptionSuccess objects.
 * @returns {Promise<void>} - A promise that resolves when the changes are written.
 */
async function writeChanges(deleter, rng, successes) {
    // prepare entries to append
    const entries = successes.map(({ source }) => {
        const filename = path.basename(source);
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
    await transaction(deleter, async (eventLogStorage) => {
        for (const entry of entries) {
            eventLogStorage.addEntry(entry, []);
        }
    });
}

module.exports = { processDiaryAudios };
