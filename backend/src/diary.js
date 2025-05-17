const path = require("path");
const { formatFileTimestamp } = require("./format_time_stamp");
const { logError, logWarning, logInfo } = require("./logger");
const { diaryAudiosDirectory } = require("./environment");
const { transaction } = require("./event_log_storage");
const eventId = require("./event/id");
const asset = require("./event/asset");
const creatorMake = require("./creator");

/** @typedef {import('./event/asset').Asset} Asset */
/** @typedef {import('./filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('./filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('./filesystem/copier').FileCopier} FileCopier */
/** @typedef {import('./filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('./filesystem/appender').FileAppender} FileAppender */
/** @typedef {import('./filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('./filesystem/file').ExistingFile} ExistingFile */
/** @typedef {import('./subprocess/command').Command} Command */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {DirScanner} scanner - A directory scanner instance.
 * @property {FileCopier} copier - A file copier instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {FileAppender} appender - A file appender instance.
 * @property {FileCreator} creator - A directory creator instance.
 * @property {Command} git - A command instance for Git operations.
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
    const inputFiles = await capabilities.scanner.scanDirectory(diaryAudiosDir);
    const creator = await creatorMake(capabilities);

    /**
     * @param {ExistingFile} file
     * @returns {Asset}
     */
    function makeAsset(file) {
        const filepath = file.path;
        const filename = path.basename(filepath);
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

        const ass = asset.make(event, file);
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
        const filename = path.basename(ass.file.path);
        logInfo(
            { filename },
            `Diary audio ${JSON.stringify(filename)} processed`
        );
    });

    failures.forEach((failure) => {
        logError(
            {
                file: failure.file.path,
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
            await capabilities.deleter.deleteFile(ass.file.path);
            logInfo(
                {
                    file: path.basename(ass.file.path),
                    directory: diaryAudiosDir,
                },
                `Deleted diary audio file: ${path.basename(ass.file.path)}`
            );
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logWarning(
                {
                    file: path.basename(ass.file.path),
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
