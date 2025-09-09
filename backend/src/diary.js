const path = require("path");
const { formatFileTimestamp } = require("./format_time_stamp");
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
/** @typedef {import('./filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('./subprocess/command').Command} Command */
/** @typedef {import('./environment').Environment} Environment */
/** @typedef {import('./logger').Logger} Logger */
/** @typedef {import('./sleeper').SleepCapability} SleepCapability */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {DirScanner} scanner - A directory scanner instance.
 * @property {FileCopier} copier - A file copier instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {FileAppender} appender - A file appender instance.
 * @property {FileCreator} creator - A directory creator instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {Command} git - A command instance for Git operations.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {import('./filesystem/reader').FileReader} reader - A file reader instance.
 * @property {import('./datetime').Datetime} datetime - Datetime utilities.
 * @property {SleepCapability} sleeper - A sleeper instance for delays.
 */

/**
 * Processes diary audio files by copying assets, updating the event log,
 * and cleaning up the originals.
 *
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @returns {Promise<void>} - A promise that resolves when processing is complete.
 */
async function processDiaryAudios(capabilities) {
    const diaryAudiosDir = capabilities.environment.diaryAudiosDirectory();
    const allFiles = await capabilities.scanner.scanDirectory(diaryAudiosDir);

    // Filter files to only include stable ones (not currently being recorded)
    const stableFiles = [];
    const unstableFiles = [];

    for (const file of allFiles) {
        try {
            const isStable = await capabilities.checker.isFileStable(file);
            if (isStable) {
                stableFiles.push(file);
            } else {
                unstableFiles.push(file);
            }
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            capabilities.logger.logWarning(
                {
                    file: file.path,
                    error: errorMessage,
                },
                `Failed to check file stability, skipping: ${file.path}`
            );
            unstableFiles.push(file);
        }
    }

    // Log information about skipped files
    if (unstableFiles.length > 0) {
        capabilities.logger.logInfo(
            {
                unstableCount: unstableFiles.length,
                totalCount: allFiles.length,
                skippedFiles: unstableFiles.map((f) => path.basename(f.path)),
            },
            `Skipping ${unstableFiles.length} unstable files that may still be recording`
        );
    }

    // Only process stable files
    const inputFiles = stableFiles;
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
            const message =
                err instanceof Object && err !== null && "message" in err
                    ? err.message
                    : String(err);
            failures.push({ file: filename, message });
        }
    }

    successes.forEach((ass) => {
        const filename = path.basename(ass.file.path);
        capabilities.logger.logInfo(
            { filename },
            `Diary audio ${JSON.stringify(filename)} processed`
        );
    });

    failures.forEach((failure) => {
        capabilities.logger.logError(
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
 * @param {Asset} ass - The processed diary audio asset to record.
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
            capabilities.logger.logInfo(
                {
                    file: path.basename(ass.file.path),
                    directory: diaryAudiosDir,
                },
                `Deleted diary audio file: ${path.basename(ass.file.path)}`
            );
        } catch (error) {
            const msg =
                error instanceof Object && error !== null && "message" in error
                    ? error.message
                    : String(error);
            capabilities.logger.logWarning(
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

module.exports = { processDiaryAudios };
