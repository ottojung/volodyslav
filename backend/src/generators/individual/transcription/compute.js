const path = require("path");
const transcribe = require("../../../transcribe");

/** @typedef {import('../../incremental_graph/database/types').TranscriptionEntry} TranscriptionEntry */
/** @typedef {import('../../../event').Event} Event */

/**
 * @typedef {object} TranscriptionCapabilities
 * @property {import('../../../ai/transcription').AITranscription} aiTranscription
 * @property {import('../../../environment').Environment} environment
 * @property {import('../../../logger').Logger} logger
 * @property {import('../../../random/seed').NonDeterministicSeed} seed
 * @property {import('../../../subprocess/command').Command} git
 * @property {import('../../../filesystem/reader').FileReader} reader
 * @property {import('../../../filesystem/checker').FileChecker} checker
 */

class InvalidTranscriptionPathError extends Error {
    /**
     * @param {string} relativeAssetPath
     */
    constructor(relativeAssetPath) {
        super(`Invalid asset path for transcription: ${relativeAssetPath}`);
        this.name = "InvalidTranscriptionPathError";
        this.relativeAssetPath = relativeAssetPath;
    }
}

/**
 * @param {unknown} object
 * @returns {object is InvalidTranscriptionPathError}
 */
function isInvalidTranscriptionPathError(object) {
    return object instanceof InvalidTranscriptionPathError;
}

class AssetEventNotFoundError extends Error {
    /**
     * @param {string} relativeAssetPath
     */
    constructor(relativeAssetPath) {
        super(`No event found for asset path ${relativeAssetPath}`);
        this.name = "AssetEventNotFoundError";
        this.relativeAssetPath = relativeAssetPath;
    }
}

/**
 * @param {unknown} object
 * @returns {object is AssetEventNotFoundError}
 */
function isAssetEventNotFoundError(object) {
    return object instanceof AssetEventNotFoundError;
}

class AssetFileNotFoundError extends Error {
    /**
     * @param {string} relativeAssetPath
     * @param {string} absoluteAssetPath
     */
    constructor(relativeAssetPath, absoluteAssetPath) {
        super(`Asset file for transcription not found: ${relativeAssetPath}`);
        this.name = "AssetFileNotFoundError";
        this.relativeAssetPath = relativeAssetPath;
        this.absoluteAssetPath = absoluteAssetPath;
    }
}

/**
 * @param {unknown} object
 * @returns {object is AssetFileNotFoundError}
 */
function isAssetFileNotFoundError(object) {
    return object instanceof AssetFileNotFoundError;
}

/**
 * @param {TranscriptionCapabilities} capabilities
 * @param {string} relativeAssetPath
 * @returns {string}
 */
function resolveAssetPath(capabilities, relativeAssetPath) {
    if (relativeAssetPath.length === 0) {
        throw new InvalidTranscriptionPathError(relativeAssetPath);
    }

    const assetsRoot = path.resolve(capabilities.environment.eventLogAssetsDirectory());
    const absoluteAssetPath = path.resolve(assetsRoot, relativeAssetPath);
    const relativeToRoot = path.relative(assetsRoot, absoluteAssetPath);

    if (
        relativeToRoot.startsWith("..") ||
        path.isAbsolute(relativeToRoot)
    ) {
        throw new InvalidTranscriptionPathError(relativeAssetPath);
    }

    return absoluteAssetPath;
}

/**
 * @param {Array<Event>} events
 * @param {string} relativeAssetPath
 * @returns {Event}
 */
function findEventForAssetPath(events, relativeAssetPath) {
    const segments = relativeAssetPath.split(path.sep).filter(Boolean);
    if (segments.length < 4) {
        throw new AssetEventNotFoundError(relativeAssetPath);
    }

    const [yearMonth, day, eventId] = segments;
    const matchingEvent = events.find((event) => {
        const month = event.date.month.toString().padStart(2, "0");
        const eventYearMonth = `${event.date.year}-${month}`;
        const eventDay = event.date.day.toString().padStart(2, "0");
        return event.id.identifier === eventId &&
            eventYearMonth === yearMonth &&
            eventDay === day;
    });

    if (matchingEvent === undefined) {
        throw new AssetEventNotFoundError(relativeAssetPath);
    }

    return matchingEvent;
}

/**
 * @param {Array<Event>} events
 * @param {string} relativeAssetPath
 * @param {TranscriptionCapabilities} capabilities
 * @returns {Promise<TranscriptionEntry>}
 */
async function computeTranscriptionForAssetPath(events, relativeAssetPath, capabilities) {
    const absoluteAssetPath = resolveAssetPath(capabilities, relativeAssetPath);
    const event = findEventForAssetPath(events, relativeAssetPath);
    const file = await capabilities.checker.instantiate(absoluteAssetPath).catch(() => {
        throw new AssetFileNotFoundError(relativeAssetPath, absoluteAssetPath);
    });
    const fileStream = capabilities.reader.createReadStream(file);
    const value = await transcribe.transcribeStream(capabilities, fileStream);
    capabilities.logger.logDebug(
        {
            event_id: event.id.identifier,
            relative_asset_path: relativeAssetPath,
            transcription_length: value.text.length,
        },
        "Transcribed event asset",
    );
    return { type: "transcription", value };
}

module.exports = {
    computeTranscriptionForAssetPath,
    isInvalidTranscriptionPathError,
    isAssetEventNotFoundError,
    isAssetFileNotFoundError,
};
