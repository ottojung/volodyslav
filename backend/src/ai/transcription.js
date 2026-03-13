/**
 * @module ai_transcription
 *
 * Purpose:
 *   OpenAI-backed audio transcription with support for long recordings,
 *   chunk-based processing, deterministic stitching, and structured extraction.
 *
 * Public API:
 *   transcribeStream(fileStream)                          => Promise<string>
 *   transcribeStreamDetailed(fileStream)                  => Promise<TranscriptionResult>
 *   transcribeStreamStructured(fileStream, schema, opts)  => Promise<{result, structured}>
 *   getTranscriberInfo()                                  => Transcriber
 */

const memconst = require("../memconst");
const memoize = require("@emotion/memoize").default;
const { OpenAI } = require("openai");
const { orchestrateTranscription, orchestrateStructuredExtraction } = require("./transcription_orchestrate");
const { TRANSCRIPTION_MODEL } = require("./transcription_openai");

/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 * @property {Command} ffprobe - ffprobe command.
 * @property {Command} ffmpeg  - ffmpeg command.
 * @property {FileCreator} creator - File creator.
 * @property {FileChecker} checker - File checker.
 * @property {FileReader} reader - File reader.
 * @property {FileDeleter} deleter - File deleter.
 */

/**
 * @typedef {Object} Transcriber
 * @property {string} name    - The model name.
 * @property {string} creator - The API provider name.
 */

/**
 * @typedef {import('./transcription_orchestrate').TranscriptionResult} TranscriptionResult
 */

class AITranscriptionError extends Error {
    /**
     * @param {string} message
     * @param {unknown} cause
     */
    constructor(message, cause) {
        super(message);
        this.name = "AITranscriptionError";
        this.cause = cause;
    }
}

/**
 * Checks if the error is an AITranscriptionError.
 * @param {unknown} object - The error to check.
 * @returns {object is AITranscriptionError}
 */
function isAITranscriptionError(object) {
    return object instanceof AITranscriptionError;
}

/**
 * @typedef {object} AITranscription
 * @property {(fileStream: import('fs').ReadStream) => Promise<string>} transcribeStream
 * @property {(fileStream: import('fs').ReadStream) => Promise<TranscriptionResult>} transcribeStreamDetailed
 * @property {(fileStream: import('fs').ReadStream, schema: Record<string, unknown>, options?: {systemPrompt?: string}) => Promise<{result: TranscriptionResult, structured: unknown}>} transcribeStreamStructured
 * @property {() => Transcriber} getTranscriberInfo
 */

/**
 * Gets the file path string from a ReadStream.
 * @param {import('fs').ReadStream} fileStream
 * @returns {string}
 */
function filePathFromStream(fileStream) {
    return String(fileStream.path);
}

/**
 * Detailed transcription: inspects the file, chunks if needed, transcribes each
 * chunk with continuity prompting, and glues results deterministically.
 *
 * @param {(apiKey: string) => OpenAI} makeOpenAI
 * @param {Capabilities} capabilities
 * @param {import('fs').ReadStream} fileStream
 * @returns {Promise<TranscriptionResult>}
 */
async function transcribeStreamDetailed(makeOpenAI, capabilities, fileStream) {
    const filePath = filePathFromStream(fileStream);
    if (!filePath) {
        throw new AITranscriptionError("Audio file stream has no path", undefined);
    }

    try {
        return await orchestrateTranscription(makeOpenAI, capabilities, filePath);
    } catch (err) {
        if (isAITranscriptionError(err)) {
            throw err;
        }
        throw new AITranscriptionError(
            `Failed to transcribe audio: ${err instanceof Error ? err.message : String(err)}`,
            err
        );
    }
}

/**
 * Simple transcription wrapper – returns only the stitched text string.
 * Delegates to transcribeStreamDetailed internally.
 *
 * @param {(apiKey: string) => OpenAI} makeOpenAI
 * @param {Capabilities} capabilities
 * @param {import('fs').ReadStream} fileStream
 * @returns {Promise<string>}
 */
async function transcribeStream(makeOpenAI, capabilities, fileStream) {
    const result = await transcribeStreamDetailed(makeOpenAI, capabilities, fileStream);
    return result.text;
}

/**
 * Structured extraction: transcribes the audio then runs a second-stage
 * structured-output pass against the stitched transcript.
 *
 * @param {(apiKey: string) => OpenAI} makeOpenAI
 * @param {Capabilities} capabilities
 * @param {import('fs').ReadStream} fileStream
 * @param {Record<string, unknown>} schema - JSON Schema for the desired structured output.
 * @param {{systemPrompt?: string}} [options]
 * @returns {Promise<{result: TranscriptionResult, structured: unknown}>}
 */
async function transcribeStreamStructured(makeOpenAI, capabilities, fileStream, schema, options) {
    const result = await transcribeStreamDetailed(makeOpenAI, capabilities, fileStream);
    return orchestrateStructuredExtraction(makeOpenAI, capabilities, result, schema, options);
}

/**
 * Gets information about the transcriber being used.
 * @returns {Transcriber}
 */
function getTranscriberInfo() {
    return {
        name: TRANSCRIPTION_MODEL,
        creator: "OpenAI",
    };
}

/**
 * Creates an AITranscription capability.
 * @param {() => Capabilities} getCapabilities
 * @returns {AITranscription}
 */
function make(getCapabilities) {
    const getCapabilitiesMemo = memconst(getCapabilities);
    const makeOpenAI = memoize((apiKey) => new OpenAI({ apiKey }));
    return {
        transcribeStream: (fileStream) =>
            transcribeStream(makeOpenAI, getCapabilitiesMemo(), fileStream),
        transcribeStreamDetailed: (fileStream) =>
            transcribeStreamDetailed(makeOpenAI, getCapabilitiesMemo(), fileStream),
        transcribeStreamStructured: (fileStream, schema, options) =>
            transcribeStreamStructured(makeOpenAI, getCapabilitiesMemo(), fileStream, schema, options),
        getTranscriberInfo,
    };
}

module.exports = {
    make,
    isAITranscriptionError,
};
