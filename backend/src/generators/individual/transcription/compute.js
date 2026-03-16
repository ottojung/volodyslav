const path = require("path");
const transcribe = require("../../../transcribe");

/** @typedef {import('../../incremental_graph/database/types').TranscriptionEntry} TranscriptionEntry */

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
 * Transcribes the audio file at the given asset-root-relative path.
 *
 * @param {string} relativeAssetPath - Path relative to the event-log assets root
 * @param {TranscriptionCapabilities} capabilities
 * @returns {Promise<TranscriptionEntry>}
 */
async function computeTranscriptionForAssetPath(relativeAssetPath, capabilities) {
    const absoluteAssetPath = resolveAssetPath(capabilities, relativeAssetPath);
    const file = await capabilities.checker.instantiate(absoluteAssetPath).catch(() => null);

    capabilities.logger.logDebug(
        {
            relative_asset_path: relativeAssetPath,
            file,
        },
        "Checking transcription file existence",
    );

    if (!file) {
        return { type: "transcription", value: { "message": `File not found: ${JSON.stringify(relativeAssetPath)}` } };
    }

    const fileStream = capabilities.reader.createReadStream(file);
    const value = await transcribe.transcribeStream(capabilities, fileStream);
    capabilities.logger.logInfo(
        {
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
};
