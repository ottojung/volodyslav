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

const {
    GoogleGenAI,
    createUserContent,
    createPartFromUri,
    AudioTranscriptionConfigMode,
} = require("@google/genai");
const { OpenAI } = require("openai");
const path = require("path");
const memconst = require("../memconst");
const memoize = require("@emotion/memoize").default;
const {
    AITranscriptionError,
    isAITranscriptionError,
    withGeminiTransientRetry,
    waitForUploadedFileToBeActive,
} = require("./transcription_gemini");

/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../sleeper').SleepCapability} SleepCapability */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {SleepCapability} sleeper - A sleeper instance.
 */

/**
 * @typedef {Object} Transcriber
 * @property {string} name - The name of the transcriber.
 * @property {string} creator - The creator of the transcriber.
 */

/**
 * @typedef {object} TranscriptionStructured
 * @property {string} transcript - The verbatim transcript text.
 */

/**
 * @typedef {object} TranscriptionResult
 * @property {string} text - The final transcript text.
 * @property {string} provider - The AI provider name.
 * @property {string} model - The model name used.
 * @property {string | null} finishReason - The candidate finish reason.
 * @property {string | null} finishMessage - The candidate finish message.
 * @property {number | null} candidateTokenCount - The token count for the candidate.
 * @property {object | null} usageMetadata - Usage metadata from the response.
 * @property {string | null} modelVersion - The model version string.
 * @property {string | null} responseId - The response ID.
 * @property {TranscriptionStructured} structured - The parsed structured output.
 * @property {unknown} rawResponse - The raw Gemini response for debugging.
 */

/** @typedef {import('./transcription_gemini').UploadedGeminiFile} UploadedGeminiFile */

/**
 * The dedicated Gemini speech-to-text model used for whole-file transcription.
 * Its primary operation is exhaustive transcription, so the request needs no
 * transcription prompt, response schema, or thinking configuration.
 */
const TRANSCRIBER_MODEL = "gemini-3.5-transcribe";

/**
 * Verbatim mode keeps filler words, repetitions, false starts, and the original
 * languages of the recording, which is what preserves multilingual and
 * code-switched speech instead of translating or normalizing it.
 */
const TRANSCRIPTION_MODE = AudioTranscriptionConfigMode.VERBATIM;

const PRECISE_TRANSCRIBER_MODEL = "gpt-4o-transcribe";

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
 * Returns the MIME type for the given file path based on its extension.
 * @param {string} filePath
 * @returns {string | undefined}
 */
function mimeTypeForPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPE_BY_EXTENSION[ext];
}

/**
 * @typedef {object} AITranscription
 * @property {(fileStream: import('fs').ReadStream) => Promise<string>} transcribeStream
 * @property {(fileStream: import('fs').ReadStream) => Promise<TranscriptionResult>} transcribeStreamDetailed
 * @property {(fileStream: import('fs').ReadStream, signal: AbortSignal) => Promise<string>} transcribeStreamPrecise
 * @property {(fileStream: import('fs').ReadStream, signal: AbortSignal) => Promise<TranscriptionResult>} transcribeStreamPreciseDetailed
 * @property {() => Transcriber} getTranscriberInfo
 */

/**
 * Transcribes short audio fragments with Whisper for precise speech-to-text output.
 * @param {function(string): OpenAI} makeClient - A memoized function to create an OpenAI client.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {import('fs').ReadStream} fileStream - The audio file stream to transcribe.
 * @param {AbortSignal} signal - Abort signal to cancel the in-flight HTTP request.
 * @returns {Promise<TranscriptionResult>}
 */
async function transcribeStreamPreciseDetailed(makeClient, capabilities, fileStream, signal) {
    const apiKey = capabilities.environment.openaiAPIKey();
    const client = makeClient(apiKey);

    let rawResponse;
    try {
        rawResponse = await client.audio.transcriptions.create(
            {
                file: fileStream,
                model: PRECISE_TRANSCRIBER_MODEL,
                response_format: "json",
            },
            { signal }
        );
    } catch (error) {
        throw new AITranscriptionError(
            `Failed to generate precise transcription: ${error instanceof Error ? error.message : String(error)}`,
            error
        );
    }

    if (!rawResponse || typeof rawResponse !== "object") {
        throw new AITranscriptionError("Precise transcription response is not an object", rawResponse);
    }

    if (typeof rawResponse.text !== "string") {
        throw new AITranscriptionError("Precise transcription response is missing 'text'", rawResponse);
    }

    return {
        text: rawResponse.text,
        provider: "OpenAI",
        model: PRECISE_TRANSCRIBER_MODEL,
        finishReason: null,
        finishMessage: null,
        candidateTokenCount: null,
        usageMetadata: null,
        modelVersion: null,
        responseId: null,
        structured: {
            transcript: rawResponse.text,
        },
        rawResponse,
    };
}

/**
 * Transcribes short audio fragments with Whisper and returns only transcript text.
 * @param {function(string): OpenAI} makeClient - A memoized function to create an OpenAI client.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {import('fs').ReadStream} fileStream - The audio file stream to transcribe.
 * @param {AbortSignal} signal - Abort signal to cancel the in-flight HTTP request.
 * @returns {Promise<string>}
 */
async function transcribeStreamPrecise(makeClient, capabilities, fileStream, signal) {
    const result = await transcribeStreamPreciseDetailed(makeClient, capabilities, fileStream, signal);
    capabilities.logger.logInfo(
        {
            file: fileStream.path,
        },
        "Precise transcription completed"
    );
    return result.text;
}

/**
 * Extracts transcript text from a Gemini transcription candidate without using
 * GenerateContentResponse.text. The SDK response-level text accessor is meant
 * for ordinary text parts; it warns to console when audioTranscription parts
 * are present and does not return their transcription text.
 *
 * Dedicated transcription responses carry their text in
 * candidate.content.parts[*].audioTranscription.text. Prefer those parts. The
 * ordinary text fallback keeps compatibility with responses that still return
 * plain text parts.
 *
 * @param {import("@google/genai").Candidate} candidate
 * @param {unknown} rawResponse
 * @returns {string}
 */
function transcriptionTextFromCandidate(candidate, rawResponse) {
    const parts = candidate.content?.parts;
    if (!Array.isArray(parts)) {
        throw new AITranscriptionError("Transcription candidate has no parts", rawResponse);
    }

    const audioTranscriptionTexts = [];
    const ordinaryTexts = [];

    for (const part of parts) {
        const audioTranscriptionText = part.audioTranscription?.text;
        if (typeof audioTranscriptionText === "string") {
            audioTranscriptionTexts.push(audioTranscriptionText);
        }

        if (typeof part.text === "string" && part.thought !== true) {
            ordinaryTexts.push(part.text);
        }
    }

    const responseText = audioTranscriptionTexts.length > 0
        ? audioTranscriptionTexts.join("")
        : ordinaryTexts.join("");

    if (responseText.trim().length === 0) {
        throw new AITranscriptionError("Transcription response has no text", rawResponse);
    }

    return responseText;
}

/**
 * Transcribes audio with full metadata using the Gemini transcription model.
 * @param {function(string): GoogleGenAI} makeClient - A memoized function to create a Gemini client.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {import('fs').ReadStream} fileStream - The audio file stream to transcribe.
 * @returns {Promise<TranscriptionResult>} - The detailed transcription result.
 */
async function transcribeStreamDetailed(makeClient, capabilities, fileStream) {
    const apiKey = capabilities.environment.geminiApiKey();
    const ai = makeClient(apiKey);

    const rawPath = fileStream.path;
    if (typeof rawPath !== "string" || rawPath.length === 0) {
        throw new AITranscriptionError("Audio file stream has no path", undefined);
    }
    const filePath = rawPath;
    const mimeType = mimeTypeForPath(filePath);
    if (!mimeType) {
        throw new AITranscriptionError(
            `Unsupported audio file extension "${path.extname(filePath) || "(none)"}". Supported extensions: ${Object.keys(MIME_TYPE_BY_EXTENSION).join(", ")}`,
            undefined
        );
    }

    /** @type {UploadedGeminiFile} */
    let audioFile = {};
    try {
        audioFile = await withGeminiTransientRetry(capabilities, "upload", async () => {
            return await ai.files.upload({
                file: filePath,
                config: { mimeType },
            });
        });
    } catch (error) {
        throw new AITranscriptionError("Failed to upload audio file for transcription", error);
    }

    try {
        try {
            audioFile = await waitForUploadedFileToBeActive(capabilities, ai, audioFile);
        } catch (error) {
            if (isAITranscriptionError(error)) {
                throw error;
            }
            throw new AITranscriptionError("Failed to activate uploaded audio file for transcription", error);
        }

        const audioFileUri = audioFile.uri;
        if (!audioFileUri) {
            throw new AITranscriptionError("Uploaded file has no URI", undefined);
        }

        const audioFileMimeType = audioFile.mimeType;
        if (!audioFileMimeType) {
            throw new AITranscriptionError("Uploaded file has no MIME type", undefined);
        }

        let rawResponse;
        try {
            rawResponse = await withGeminiTransientRetry(capabilities, "generation", async () => {
                return await ai.models.generateContent({
                    model: TRANSCRIBER_MODEL,
                    contents: createUserContent([
                        createPartFromUri(audioFileUri, audioFileMimeType),
                    ]),
                    config: {
                        audioTranscriptionConfig: {
                            mode: TRANSCRIPTION_MODE,
                        },
                    },
                });
            });
        } catch (error) {
            if (isAITranscriptionError(error)) {
                throw error;
            }
            throw new AITranscriptionError(
                `Failed to generate transcription: ${error instanceof Error ? error.message : String(error)}`,
                error
            );
        }

        const candidates = rawResponse.candidates;
        if (!candidates || candidates.length === 0) {
            throw new AITranscriptionError("No candidates in transcription response", rawResponse);
        }

        const candidate = candidates[0];
        if (!candidate || !candidate.content) {
            throw new AITranscriptionError("Candidate has no content", rawResponse);
        }

        const finishReason = candidate.finishReason ?? null;
        const finishMessage = candidate.finishMessage ?? null;
        const candidateTokenCount = candidate.tokenCount ?? null;
        const usageMetadata = rawResponse.usageMetadata ?? null;
        const modelVersion = rawResponse.modelVersion ?? null;
        const responseId = rawResponse.responseId ?? null;

        if (finishReason === "MAX_TOKENS") {
            const msg = finishMessage
                ? `Transcription was truncated (MAX_TOKENS): ${finishMessage}`
                : "Transcription was truncated (MAX_TOKENS)";
            throw new AITranscriptionError(msg, rawResponse);
        }

        const responseText = transcriptionTextFromCandidate(candidate, rawResponse);

        return {
            text: responseText,
            provider: "Google",
            model: TRANSCRIBER_MODEL,
            finishReason,
            finishMessage,
            candidateTokenCount,
            usageMetadata,
            modelVersion,
            responseId,
            structured: {
                transcript: responseText,
            },
            rawResponse,
        };
    } finally {
        if (audioFile.name) {
            try {
                await ai.files.delete({ name: audioFile.name });
            } catch (deleteError) {
                capabilities.logger.logWarning(
                    {},
                    `Failed to delete uploaded Gemini file ${audioFile.name}: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`
                );
            }
        }
    }
}

/**
 * Transcribes audio from a readable stream using the Gemini API.
 * @param {function(string): GoogleGenAI} makeClient - A memoized function to create a Gemini client.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {import('fs').ReadStream} fileStream - The audio file stream to transcribe.
 * @returns {Promise<string>} - The transcribed text.
 */
async function transcribeStream(makeClient, capabilities, fileStream) {
    const result = await transcribeStreamDetailed(makeClient, capabilities, fileStream);
    capabilities.logger.logInfo(
        {
            file: fileStream.path,
            candidateTokenCount: result.candidateTokenCount,
            finishReason: result.finishReason,
        },
        "Transcription completed"
    );
    return result.text;
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
    const makeOpenAIClient = memoize((apiKey) => new OpenAI({ apiKey }));
    return {
        transcribeStream: (fileStream) => transcribeStream(makeClient, getCapabilitiesMemo(), fileStream),
        transcribeStreamDetailed: (fileStream) =>
            transcribeStreamDetailed(makeClient, getCapabilitiesMemo(), fileStream),
        transcribeStreamPrecise: (fileStream, signal) =>
            transcribeStreamPrecise(makeOpenAIClient, getCapabilitiesMemo(), fileStream, signal),
        transcribeStreamPreciseDetailed: (fileStream, signal) =>
            transcribeStreamPreciseDetailed(makeOpenAIClient, getCapabilitiesMemo(), fileStream, signal),
        getTranscriberInfo,
    };
}

module.exports = {
    make,
    isAITranscriptionError,
    TRANSCRIBER_MODEL,
    PRECISE_TRANSCRIBER_MODEL,
    TRANSCRIPTION_MODE,
};
