/**
 * @module ai_transcription
 *
 * Purpose:
 *   This module provides a unified abstraction for AI-powered transcription services,
 *   decoupling direct OpenAI API calls from application logic.
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

const { OpenAI } = require("openai");
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

const TRANSCRIBER_MODEL = "gpt-4o-mini-transcribe";

/**
 * @typedef {object} AITranscription
 * @property {(fileStream: import('fs').ReadStream) => Promise<string>} transcribeStream
 * @property {() => Transcriber} getTranscriberInfo
 */

/**
 * Transcribes audio from a readable stream.
 * @param {function(string): OpenAI} openai - A memoized function to create an OpenAI client.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {import('fs').ReadStream} fileStream - The audio file stream to transcribe.
 * @returns {Promise<string>} - The transcribed text.
 */
async function transcribeStream(openai, capabilities, fileStream) {
    try {
        const apiKey = capabilities.environment.openaiAPIKey();
        const responseText = await openai(apiKey).audio.transcriptions.create({
            file: fileStream,
            model: TRANSCRIBER_MODEL,
            response_format: "text",
        });
        return responseText;
    } catch (error) {
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
        creator: "OpenAI",
    };
}

/**
 * Creates an AITranscription capability.
 * @param {Capabilities} capabilities - The capabilities object.
 * @returns {AITranscription} - The AI transcription interface.
 */
function make(capabilities) {
    const openai = memoize((apiKey) => new OpenAI({ apiKey }));
    return {
        transcribeStream: (fileStream) => transcribeStream(openai, capabilities, fileStream),
        getTranscriberInfo,
    };
}

module.exports = {
    make,
    isAITranscriptionError,
};
