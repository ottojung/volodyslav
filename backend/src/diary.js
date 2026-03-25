const path = require("path");
const datetime = require("./datetime");
const { formatFileTimestamp } = require("./format_time_stamp");
const { transaction } = require("./event_log_storage");
const event = require("./event");
const eventId = event.id;
const asset = event.asset;
const creatorMake = require("./creator");
const { makeFromExistingFile } = require("./filesystem").file_ref;

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
 * @property {import('./generators').Interface} interface - The incremental graph interface capability.
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
     * Diary audio filenames encode timestamps in UTC, but the recording time should
     * be interpreted in the local configured timezone for downstream consistency.
     *
     * @param {string} filename
     * @returns {import("./datetime").DateTime}
     */
    function diaryDateFromFilename(filename) {
        const utcDate = formatFileTimestamp(filename);
        return datetime.setZone(utcDate, capabilities.datetime.timeZone());
    }

    /**
     * @param {ExistingFile} file
     * @returns {Asset}
     */
    function makeAsset(file) {
        const filepath = file.path;
        const filename = path.basename(filepath);
        const date = diaryDateFromFilename(filename);
        const id = eventId.make(capabilities);

        /** @type {import('./event/structure').Event} */
        const event = {
            id,
            date,
            original: `diary [when 0 hours ago] [audiorecording]`,
            input: `diary [when 0 hours ago] [audiorecording]`,
            creator,
        };

        const fileRef = makeFromExistingFile(file, (p) => capabilities.reader.readFileAsBuffer(p));
        const ass = asset.make(event, fileRef);
        return ass;
    }

    /**
     * @typedef {{ ass: Asset, originalFile: ExistingFile }} DiarySuccess
     * @typedef {{ originalFile: ExistingFile, message: string }} DiaryFailure
     */

    /** @type {DiarySuccess[]} */
    const successes = [];
    /** @type {DiaryFailure[]} */
    const failures = [];

    // now update the event-log storage.
    for (const file of inputFiles) {
        try {
            const ass = makeAsset(file);
            await writeAsset(capabilities, ass);
            successes.push({ ass, originalFile: file });
        } catch (err) {
            const message =
                err instanceof Object && err !== null && "message" in err
                    ? String(err.message)
                    : String(err);
            failures.push({ originalFile: file, message });
        }
    }

    successes.forEach(({ ass }) => {
        const filename = ass.file.filename;
        capabilities.logger.logInfo(
            { filename },
            `Diary audio ${JSON.stringify(filename)} processed`
        );
    });

    failures.forEach((failure) => {
        capabilities.logger.logError(
            {
                file: failure.originalFile.path,
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
 * @param {Array<{ass: Asset, originalFile: ExistingFile}>} successes - An array of successfully processed assets with their original files.
 * @param {string} diaryAudiosDir - The directory containing the diary audio files.
 */
async function deleteOriginalAudios(capabilities, successes, diaryAudiosDir) {
    for (const { originalFile } of successes) {
        const filePath = originalFile.path;
        const filename = path.basename(filePath);
        try {
            await capabilities.deleter.deleteFile(filePath);
            capabilities.logger.logInfo(
                {
                    file: filename,
                    directory: diaryAudiosDir,
                },
                `Deleted diary audio file: ${filename}`
            );
        } catch (error) {
            const msg =
                error instanceof Object && error !== null && "message" in error
                    ? error.message
                    : String(error);
            capabilities.logger.logWarning(
                {
                    file: filename,
                    error: msg,
                    directory: diaryAudiosDir,
                },
                `Failed to delete diary audio file: ${msg}`
            );
        }
    }
}

module.exports = { processDiaryAudios };
