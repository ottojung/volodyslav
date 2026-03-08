/**
 * @module ai_transcription
 *
 * Purpose:
 *   This module provides a unified abstraction for AI-powered transcription services,
 *   decoupling direct Gemini API calls from application logic.
 *
 * Why this Module Exists:
 *   Direct API calls can scatter configuration and error handling throughout the codebase.
 *   Centralizing transcription logic here ensures a single place to manage API interactions,
 *   keeping application code clean and maintainable.
 *
 * Conceptual Design Principles:
 *   • Single Responsibility - Focused solely on the semantics of audio transcription.
 *   • Error Abstraction - Handles API-specific errors and provides consistent error types.
 *   • Promise-Based API - Leverages async/await for clear asynchronous flows.
 *   • Factory Pattern - Exposes a make() function for easy dependency injection or mocking.
 */

const { GoogleGenAI, createUserContent, createPartFromUri } = require("@google/genai");
const path = require("path");
const memconst = require("../memconst");
const memoize = require("@emotion/memoize").default;

/** @typedef {import('../environment').Environment} Environment */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 */

/**
 * @typedef {Object} Transcriber
 * @property {string} name - The name of the transcriber.
 * @property {string} creator - The creator of the transcriber.
 */

class AITranscriptionError extends Error {
    /**
     * @param {string} message
     * @param {unknown} cause
     */
    constructor(message, cause) {
        super(message);
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

const TRANSCRIBER_MODEL = "gemini-2.0-flash";

/** @type {Record<string, string>} */
const MIME_TYPE_BY_EXTENSION = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
};

/**
 * Returns the MIME type for the given file path based on its extension,
 * defaulting to "audio/mpeg" for unknown extensions.
 * @param {string} filePath
 * @returns {string}
 */
function mimeTypeForPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPE_BY_EXTENSION[ext] ?? "audio/mpeg";
}

/**
 * @typedef {object} AITranscription
 * @property {(fileStream: import('fs').ReadStream) => Promise<string>} transcribeStream
 * @property {() => Transcriber} getTranscriberInfo
 */

/**
 * Transcribes audio from a readable stream using the Gemini API.
 * @param {function(string): GoogleGenAI} makeClient - A memoized function to create a Gemini client.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {import('fs').ReadStream} fileStream - The audio file stream to transcribe.
 * @returns {Promise<string>} - The transcribed text.
 */
async function transcribeStream(makeClient, capabilities, fileStream) {
    try {
        const apiKey = capabilities.environment.geminiApiKey();
        const ai = makeClient(apiKey);

        const filePath = String(fileStream.path);
        if (!filePath) {
            throw new AITranscriptionError("Audio file stream has no path", undefined);
        }

        const audioFile = await ai.files.upload({
            file: filePath,
            config: { mimeType: mimeTypeForPath(filePath) },
        });

        if (!audioFile.uri) {
            throw new AITranscriptionError("Uploaded file has no URI", undefined);
        }

        if (!audioFile.mimeType) {
            throw new AITranscriptionError("Uploaded file has no MIME type", undefined);
        }

        const result = await ai.models.generateContent({
            model: TRANSCRIBER_MODEL,
            contents: createUserContent([
                createPartFromUri(audioFile.uri, audioFile.mimeType),
                "Generate a transcript of the speech. Preserve line breaks where natural.",
            ]),
        });

        if (!result.text) {
            throw new AITranscriptionError("Transcription result has no text", undefined);
        }

        return result.text;
    } catch (error) {
        if (isAITranscriptionError(error)) {
            throw error;
        }
        throw new AITranscriptionError(
            `Failed to transcribe audio: ${error instanceof Error ? error.message : String(error)}`,
            error
        );
    }
}

/**
 * Gets information about the transcriber being used.
 * @returns {Transcriber} - Information about the transcriber.
 */
function getTranscriberInfo() {
    return {
        name: TRANSCRIBER_MODEL,
        creator: "Google",
    };
}

/**
 * Creates an AITranscription capability.
 * @param {() => Capabilities} getCapabilities - The capabilities object.
 * @returns {AITranscription} - The AI transcription interface.
 */
function make(getCapabilities) {
    const getCapabilitiesMemo = memconst(getCapabilities);
    const makeClient = memoize((apiKey) => new GoogleGenAI({ apiKey }));
    return {
        transcribeStream: (fileStream) => transcribeStream(makeClient, getCapabilitiesMemo(), fileStream),
        getTranscriberInfo,
    };
}

module.exports = {
    make,
    isAITranscriptionError,
};
