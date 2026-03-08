/**
 * Handler for GET /entries/:id/additional-properties
 *
 * Triggers the incremental graph to pull calories(e) and event_transcription(e, a)
 * for the given entry id and returns any non-zero additional properties.
 */

const path = require("path");
const { getEntryById } = require("../../entry");
const { isEventNotFoundError } = require("../../generators");
const { isDirScannerError } = require("../../filesystem").dirscanner;

/** @typedef {import('../../request_identifier').RequestIdentifier} RequestIdentifier */
/** @typedef {import('../../logger').Logger} Logger */
/** @typedef {import('../../generators').Interface} Interface */

/**
 * @typedef {object} Capabilities
 * @property {Logger} logger - A logger instance.
 * @property {Interface} interface - The incremental graph interface capability.
 * @property {import('../../environment').Environment} environment - An environment instance.
 * @property {import('../../filesystem/checker').FileChecker} checker - A file checker instance.
 * @property {import('../../filesystem/dirscanner').DirScanner} scanner - A directory scanner instance.
 * @property {import('../../filesystem/appender').FileAppender} appender - A file appender instance.
 * @property {import('../../filesystem/creator').FileCreator} creator - A file creator instance.
 * @property {import('../../filesystem/reader').FileReader} reader - A file reader instance.
 * @property {import('../../datetime').Datetime} datetime - Datetime utilities.
 * @property {import('../../subprocess/command').Command} git - A command instance for Git operations.
 * @property {import('../../random/seed').NonDeterministicSeed} seed - A random number generator.
 * @property {import('../../filesystem/deleter').FileDeleter} deleter - A file deleter instance.
 * @property {import('../../filesystem/copier').FileCopier} copier - A file copier instance.
 * @property {import('../../filesystem/writer').FileWriter} writer - A file writer instance.
 * @property {import('../../sleeper').SleepCapability} sleeper - A sleeper instance.
 */

/**
 * @typedef {object} AdditionalProperties
 * @property {number} [calories] - Estimated calorie count; omitted when 0 or unknown.
 * @property {string} [transcription] - Transcription text; omitted when unavailable.
 */

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".opus", ".weba"]);

/**
 * @param {string} filename
 * @returns {boolean}
 */
function isAudioFilename(filename) {
    return AUDIO_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

/**
 * Computes the directory path where an entry's assets are stored.
 * @param {string} assetsDir
 * @param {import('../../event/structure').Event} entry
 * @returns {string}
 */
function entryAssetsDir(assetsDir, entry) {
    const date = entry.date;
    const year = date.year;
    const month = date.month.toString().padStart(2, "0");
    const day = date.day.toString().padStart(2, "0");
    return path.join(assetsDir, `${year}-${month}`, day, entry.id.identifier);
}

/**
 * Tries to find a transcription for one of the audio assets associated with the entry.
 * Returns the text of the first successful transcription, or null if none found.
 * @param {string} entryId
 * @param {Capabilities} capabilities
 * @returns {Promise<string|null>}
 */
async function tryGetTranscriptionText(entryId, capabilities) {
    const entry = await getEntryById(capabilities, entryId);
    if (entry === null) {
        return null;
    }

    const assetsDir = capabilities.environment.eventLogAssetsDirectory();
    const dirPath = entryAssetsDir(assetsDir, entry);
    const dirProof = await capabilities.checker.directoryExists(dirPath);
    if (dirProof === null) {
        return null;
    }

    let files;
    try {
        files = await capabilities.scanner.scanDirectory(dirPath);
    } catch (error) {
        if (isDirScannerError(error)) {
            return null;
        }
        throw error;
    }

    for (const file of files) {
        const proof = await capabilities.checker.fileExists(file.path);
        if (proof === null) continue;

        const filename = path.basename(file.path);
        if (!isAudioFilename(filename)) continue;

        const relativeAssetPath = path.relative(assetsDir, file.path);

        try {
            const transcriptionEntry = await capabilities.interface.getEventTranscriptionForAudioPath(
                entryId,
                relativeAssetPath,
            );
            return transcriptionEntry.transcription.text;
        } catch (error) {
            // This audio file has no transcription; try the next one.
            capabilities.logger.logDebug(
                { entry_id: entryId, asset_path: relativeAssetPath, error: error instanceof Error ? error.message : String(error) },
                "No transcription available for audio asset, skipping",
            );
        }
    }

    return null;
}

/**
 * Handles the GET /entries/:id/additional-properties logic.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Capabilities} capabilities
 * @param {RequestIdentifier} reqId
 * @returns {Promise<void>}
 */
async function handleAdditionalProperties(req, res, capabilities, reqId) {
    const { id } = req.params;

    if (typeof id !== "string" || id.trim() === "") {
        res.status(400).json({ error: "Invalid entry id" });
        return;
    }

    if (!capabilities.interface.isInitialized()) {
        capabilities.logger.logError(
            { request_identifier: reqId.identifier, entry_id: id },
            "additional-properties: incremental graph is not initialized",
        );
        res.status(503).json({ error: "Graph not initialized" });
        return;
    }

    try {
        const caloriesEntry = await capabilities.interface.getCaloriesForEventId(id);

        capabilities.logger.logDebug(
            {
                request_identifier: reqId.identifier,
                entry_id: id,
                calories_entry: caloriesEntry,
            },
            "Pulled calories entry for additional properties",
        );

        /** @type {AdditionalProperties} */
        const properties = {};

        if (
            caloriesEntry &&
            caloriesEntry.type === "calories" &&
            caloriesEntry.value > 0
        ) {
            properties.calories = caloriesEntry.value;
        }

        const transcriptionText = await tryGetTranscriptionText(id, capabilities);
        if (transcriptionText !== null) {
            properties.transcription = transcriptionText;
        }

        res.json(properties);
    } catch (error) {
        // An unknown entry ID simply has no additional properties.
        if (isEventNotFoundError(error)) {
            res.json({});
            return;
        }

        const message = error instanceof Error ? error.message : String(error);

        capabilities.logger.logError(
            {
                request_identifier: reqId.identifier,
                error: message,
                error_name: error instanceof Error ? error.name : "Unknown",
                stack: error instanceof Error ? error.stack : undefined,
                entry_id: id,
                client_ip: req.ip,
            },
            `Failed to compute additional properties for entry ${id}: ${message}`,
        );

        res.status(500).json({ error: "Internal server error" });
    }
}

module.exports = { handleAdditionalProperties };
