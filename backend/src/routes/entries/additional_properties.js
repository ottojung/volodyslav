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
 * @property {number} [calories] - Estimated calorie count; omitted when N/A (non-food entry) or unknown.
 * @property {string} [transcription] - Transcription text; omitted when unavailable.
 * @property {string[]} [basic_context] - Input fields from the basic context events.
 * @property {Object<string, string>} [errors] - Per-property error messages; omitted when no errors.
 */

/**
 * @typedef {'calories' | 'transcription' | 'basic_context'} AdditionalPropertyName
 */

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".opus", ".weba"]);

/**
 * @param {string} filename
 * @returns {boolean}
 */
function isAudioFilename(filename) {
    if (filename.endsWith("diary-audio.webm")) {
        return true;
    }
    if (AUDIO_EXTENSIONS.has(path.extname(filename).toLowerCase())) {
        return true;
    }
    return false;
}

const ADDITIONAL_PROPERTY_NAMES = new Set(["calories", "transcription", "basic_context"]);

/**
 * @param {unknown} value
 * @returns {value is AdditionalPropertyName}
 */
function isAdditionalPropertyName(value) {
    return typeof value === "string" && ADDITIONAL_PROPERTY_NAMES.has(value);
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
 * Result of attempting to get a transcription for an entry.
 * @typedef {{ text: string } | { error: string }} TranscriptionResult
 * - `{ text: string }` when at least one audio asset was successfully transcribed.
 * - `{ error: string }` when audio assets exist but all transcription attempts failed.
 * Returns `null` when the entry has no audio assets (normal empty case).
 */

/**
 * Tries to find a transcription for one of the audio assets associated with the entry.
 * Returns the text of the first successful transcription, an error object when all
 * audio assets fail to transcribe, or null when there are no relevant audio assets.
 * @param {string} entryId
 * @param {Capabilities} capabilities
 * @returns {Promise<TranscriptionResult | null>}
 */
async function tryGetTranscriptionText(entryId, capabilities) {
    const entry = await getEntryById(capabilities, entryId);
    if (entry === null) {
        return null;
    }

    capabilities.logger.logDebug(
        { entry }, "Attempting to get transcription for entry",
    );

    const assetsDir = capabilities.environment.eventLogAssetsDirectory();
    const dirPath = entryAssetsDir(assetsDir, entry);
    const dirProof = await capabilities.checker.directoryExists(dirPath);
    if (dirProof === null) {
        capabilities.logger.logDebug(
            { entry },
            "No assets directory for entry, skipping transcription",
        );
        return null;
    }

    let files;
    try {
        files = await capabilities.scanner.scanDirectory(dirPath);
    } catch (error) {
        if (isDirScannerError(error)) {
            capabilities.logger.logError(
                { entry, error },
                "Failed to scan assets directory for entry, skipping transcription",
            );
            return null;
        }
        throw error;
    }

    capabilities.logger.logDebug(
        { entry, files },
        "Scanned assets directory for entry, attempting transcription on audio files",
    );

    /** @type {string | null} */
    let transcriptionError = null;

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
            if ('message' in transcriptionEntry.transcription) {
                const errorMessage = transcriptionEntry.transcription.message;
                capabilities.logger.logDebug(
                    { entry_id: entryId, asset_path: relativeAssetPath, error: errorMessage },
                    "No transcription available for audio asset, skipping",
                );
                transcriptionError = errorMessage;
                continue;
            }
            return { text: transcriptionEntry.transcription.text };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            // This audio file has no transcription; try the next one.
            capabilities.logger.logDebug(
                { entry_id: entryId, asset_path: relativeAssetPath, error: errorMessage },
                "No transcription available for audio asset, skipping",
            );
            transcriptionError = errorMessage;
        }
    }

    if (transcriptionError !== null) {
        return { error: transcriptionError };
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
    const { property } = req.query;

    if (typeof id !== "string" || id.trim() === "") {
        res.status(400).json({ error: "Invalid entry id" });
        return;
    }

    if (property !== undefined && !isAdditionalPropertyName(property)) {
        res.status(400).json({ error: "Invalid additional property" });
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

    /** @type {Omit<AdditionalProperties, 'errors'>} */
    const properties = {};

    /** @type {Object<string, string>} */
    const errors = {};

    if (property === undefined || property === "calories") {
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

            if (
                caloriesEntry &&
                caloriesEntry.type === "calories" &&
                caloriesEntry.value !== "N/A"
            ) {
                properties.calories = caloriesEntry.value;
            }
        } catch (error) {
            if (!isEventNotFoundError(error)) {
                const message = error instanceof Error ? error.message : String(error);
                errors["calories"] = message;
                capabilities.logger.logError(
                    {
                        request_identifier: reqId.identifier,
                        entry_id: id,
                        error: message,
                    },
                    `Failed to compute calories for entry ${id}: ${message}`,
                );
            }
        }
    }

    if (property === undefined || property === "transcription") {
        try {
            const transcriptionResult = await tryGetTranscriptionText(id, capabilities);
            if (transcriptionResult !== null) {
                if ('text' in transcriptionResult) {
                    properties.transcription = transcriptionResult.text;
                } else {
                    errors["transcription"] = transcriptionResult.error;
                }
            }
        } catch (error) {
            if (!isEventNotFoundError(error)) {
                const message = error instanceof Error ? error.message : String(error);
                errors["transcription"] = message;
                capabilities.logger.logError(
                    {
                        request_identifier: reqId.identifier,
                        entry_id: id,
                        error: message,
                    },
                    `Failed to compute transcription for entry ${id}: ${message}`,
                );
            }
        }
    }

    if (property === undefined || property === "basic_context") {
        try {
            const basicContextEntry = await capabilities.interface.getBasicContextForEventId(id);

            capabilities.logger.logDebug(
                {
                    request_identifier: reqId.identifier,
                    entry_id: id,
                    basic_context_entry: basicContextEntry,
                },
                "Pulled basic_context entry for additional properties",
            );

            properties.basic_context = basicContextEntry.events.map((e) => e.input);
        } catch (error) {
            if (!isEventNotFoundError(error)) {
                const message = error instanceof Error ? error.message : String(error);
                errors["basic_context"] = message;
                capabilities.logger.logError(
                    {
                        request_identifier: reqId.identifier,
                        entry_id: id,
                        error: message,
                    },
                    `Failed to compute basic_context for entry ${id}: ${message}`,
                );
            }
        }
    }

    /** @type {AdditionalProperties} */
    const response = Object.keys(errors).length > 0
        ? { ...properties, errors }
        : properties;

    res.json(response);
}

module.exports = { handleAdditionalProperties };
