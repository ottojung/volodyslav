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

const { GoogleGenAI, createUserContent, createPartFromUri, ThinkingLevel } = require("@google/genai");
const path = require("path");
const memconst = require("../memconst");
const memoize = require("@emotion/memoize").default;
const { fromMilliseconds } = require("../datetime");

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
 * @property {"full" | "partial"} coverage - Whether the transcript covers the full audio.
 * @property {string[]} warnings - Any warnings about the transcription.
 * @property {boolean} unclearAudio - Whether any audio was unclear.
 */

/**
 * @typedef {object} TranscriptionResult
 * @property {string} text - The final transcript text.
 * @property {string} provider - The AI provider name ("Google").
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

/**
 * @typedef {object} UploadedGeminiFile
 * @property {string | undefined} [uri]
 * @property {string | undefined} [mimeType]
 * @property {string | undefined} [name]
 * @property {string | { name?: string } | undefined} [state]
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

const TRANSCRIBER_MODEL = "gemini-3-flash-preview";
const MAX_OUTPUT_TOKENS = 65536;
const TEMPERATURE = 0.0;
const THINKING_LEVEL = ThinkingLevel.LOW;
const RETRYABLE_HTTP_STATUS_CODES = [429, 500, 503, 504];
const RETRYABLE_ERROR_CODES = ["RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE", "DEADLINE_EXCEEDED"];
const RETRY_MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 4000;
const FILE_ACTIVATION_MAX_ATTEMPTS = 30;
const FILE_ACTIVATION_POLL_DELAY_MS = 1000;

/** @type {Record<string, string>} */
const MIME_TYPE_BY_EXTENSION = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
};

const TRANSCRIPTION_PROMPT =
    "You are a transcription service. Your only task is to produce a verbatim transcript of the audio.\n" +
    "Rules:\n" +
    "- Transcribe exactly what is spoken. Do not paraphrase, summarize, rewrite, or clean up the speech.\n" +
    "- Do not add commentary, analysis, or explanations.\n" +
    "- Do not translate. Preserve multilingual and code-switched speech exactly as spoken.\n" +
    "- Do not invent or infer speaker labels. Do not add diarization.\n" +
    "- Preserve natural line breaks where they occur in speech.\n" +
    "- If a portion of audio is unclear or inaudible, mark it as [unclear] in the transcript and set unclearAudio to true.\n" +
    "- Do not add punctuation or capitalization that is not clearly implied by the speech.\n" +
    "Return your response as JSON matching the required schema with fields: transcript, coverage, warnings, unclearAudio.";

const RESPONSE_SCHEMA = {
    type: "object",
    properties: {
        transcript: { type: "string" },
        coverage: {
            type: "string",
            enum: ["full", "partial"],
        },
        warnings: {
            type: "array",
            items: { type: "string" },
        },
        unclearAudio: { type: "boolean" },
    },
    required: ["transcript", "coverage", "warnings", "unclearAudio"],
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
 * @param {unknown} error
 * @returns {number | null}
 */
function extractStatusCode(error) {
    if (typeof error !== "object" || error === null) {
        return null;
    }
    if ("status" in error && typeof error.status === "number") {
        return error.status;
    }
    if ("statusCode" in error && typeof error.statusCode === "number") {
        return error.statusCode;
    }
    if ("code" in error && typeof error.code === "number") {
        return error.code;
    }
    return null;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function extractErrorCode(error) {
    if (typeof error !== "object" || error === null) {
        return "";
    }
    if ("code" in error && typeof error.code === "string") {
        return error.code.toUpperCase();
    }
    if ("statusText" in error && typeof error.statusText === "string") {
        return error.statusText.toUpperCase();
    }
    if ("message" in error && typeof error.message === "string") {
        const normalized = error.message.toUpperCase();
        for (const code of RETRYABLE_ERROR_CODES) {
            if (normalized.includes(code)) {
                return code;
            }
        }
    }
    return "";
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableGeminiError(error) {
    const statusCode = extractStatusCode(error);
    if (statusCode !== null && RETRYABLE_HTTP_STATUS_CODES.includes(statusCode)) {
        return true;
    }
    const code = extractErrorCode(error);
    return RETRYABLE_ERROR_CODES.includes(code);
}

/**
 * @param {number} attempt
 * @returns {number}
 */
function retryDelayMs(attempt) {
    const exponential = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);
    const jittered = Math.floor(exponential * (0.5 + Math.random()));
    return Math.max(1, Math.min(jittered, RETRY_MAX_DELAY_MS));
}

/**
 * @template T
 * @param {Capabilities} capabilities
 * @param {"upload" | "generation"} stage
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function withGeminiTransientRetry(capabilities, stage, operation) {
    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (!isRetryableGeminiError(error) || attempt >= RETRY_MAX_ATTEMPTS) {
                throw error;
            }
            const delayMs = retryDelayMs(attempt);
            capabilities.logger.logWarning(
                {
                    stage,
                    attempt,
                    maxAttempts: RETRY_MAX_ATTEMPTS,
                    retryDelayMs: delayMs,
                    statusCode: extractStatusCode(error),
                    errorCode: extractErrorCode(error),
                },
                `Transient Gemini ${stage} failure on attempt ${attempt}; retrying`
            );
            await capabilities.sleeper.sleep(
                `gemini ${stage} retry delay`,
                fromMilliseconds(delayMs)
            );
        }
    }
    throw new AITranscriptionError(`Unexpected retry exhaustion at ${stage} stage`, undefined);
}

/**
 * @param {unknown} file
 * @returns {string}
 */
function fileStateName(file) {
    if (typeof file !== "object" || file === null || !("state" in file)) {
        return "";
    }
    const state = file.state;
    if (typeof state === "string") {
        return state.toUpperCase();
    }
    if (typeof state === "object" && state !== null && "name" in state && typeof state.name === "string") {
        return state.name.toUpperCase();
    }
    return "";
}

/**
 * @param {Capabilities} capabilities
 * @param {GoogleGenAI} ai
 * @param {UploadedGeminiFile} uploadedFile
 * @returns {Promise<UploadedGeminiFile>}
 */
async function waitForUploadedFileToBeActive(capabilities, ai, uploadedFile) {
    /** @type {UploadedGeminiFile} */
    let currentFile = uploadedFile;
    for (let attempt = 1; attempt <= FILE_ACTIVATION_MAX_ATTEMPTS; attempt++) {
        const state = fileStateName(currentFile);
        if (state === "ACTIVE") {
            return currentFile;
        }
        if (state === "FAILED") {
            throw new AITranscriptionError("File activation failed: uploaded Gemini file entered FAILED state", currentFile);
        }
        if (!currentFile.name) {
            throw new AITranscriptionError("File activation failed: uploaded Gemini file has no name for status polling", currentFile);
        }
        if (attempt >= FILE_ACTIVATION_MAX_ATTEMPTS) {
            throw new AITranscriptionError(
                `File activation timed out: Gemini file did not become ACTIVE after ${FILE_ACTIVATION_MAX_ATTEMPTS} checks`,
                currentFile
            );
        }
        await capabilities.sleeper.sleep(
            "gemini file activation poll delay",
            fromMilliseconds(FILE_ACTIVATION_POLL_DELAY_MS)
        );
        try {
            const file = await ai.files.get({ name: currentFile.name });
            if (!file || typeof file !== "object") {
                throw new AITranscriptionError("File activation failed: Gemini status check returned an invalid file object", file);
            }
            currentFile = file;
        } catch (error) {
            if (!isRetryableGeminiError(error)) {
                throw new AITranscriptionError("File activation failed while checking Gemini file status", error);
            }
            capabilities.logger.logWarning(
                {
                    stage: "file-activation",
                    attempt,
                    maxAttempts: FILE_ACTIVATION_MAX_ATTEMPTS,
                    statusCode: extractStatusCode(error),
                    errorCode: extractErrorCode(error),
                },
                `Transient Gemini file activation status check failure on attempt ${attempt}; retrying`
            );
        }
    }
    throw new AITranscriptionError("Unexpected file activation polling exhaustion", uploadedFile);
}

/**
 * @typedef {object} AITranscription
 * @property {(fileStream: import('fs').ReadStream) => Promise<string>} transcribeStream
 * @property {(fileStream: import('fs').ReadStream) => Promise<TranscriptionResult>} transcribeStreamDetailed
 * @property {() => Transcriber} getTranscriberInfo
 */

/**
 * Transcribes audio with full metadata using the Gemini API.
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
                        TRANSCRIPTION_PROMPT,
                    ]),
                    config: {
                        maxOutputTokens: MAX_OUTPUT_TOKENS,
                        temperature: TEMPERATURE,
                        thinkingConfig: {
                            thinkingLevel: THINKING_LEVEL,
                        },
                        responseMimeType: "application/json",
                        responseSchema: RESPONSE_SCHEMA,
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

        const responseText = rawResponse.text;
        if (!responseText) {
            throw new AITranscriptionError("Transcription response has no text", rawResponse);
        }

        let structured;
        try {
            structured = JSON.parse(responseText);
        } catch (error) {
            throw new AITranscriptionError(
                `Failed to parse transcription JSON response: ${error instanceof Error ? error.message : String(error)}`,
                rawResponse
            );
        }

        if (!structured || typeof structured !== "object") {
            throw new AITranscriptionError("Transcription response is not a JSON object", rawResponse);
        }

        if (typeof structured.transcript !== "string") {
            throw new AITranscriptionError("Transcription response is missing 'transcript'", rawResponse);
        }

        const normalizedWarnings = Array.isArray(structured.warnings) ? structured.warnings : [];
        const normalizedUnclearAudio = typeof structured.unclearAudio === "boolean" ? structured.unclearAudio : false;

        return {
            text: structured.transcript,
            provider: "Google",
            model: TRANSCRIBER_MODEL,
            finishReason,
            finishMessage,
            candidateTokenCount,
            usageMetadata,
            modelVersion,
            responseId,
            structured: {
                transcript: structured.transcript,
                coverage: structured.coverage,
                warnings: normalizedWarnings,
                unclearAudio: normalizedUnclearAudio,
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
    return {
        transcribeStream: (fileStream) => transcribeStream(makeClient, getCapabilitiesMemo(), fileStream),
        transcribeStreamDetailed: (fileStream) =>
            transcribeStreamDetailed(makeClient, getCapabilitiesMemo(), fileStream),
        getTranscriberInfo,
    };
}

module.exports = {
    make,
    isAITranscriptionError,
    TRANSCRIBER_MODEL,
    MAX_OUTPUT_TOKENS,
    TEMPERATURE,
    THINKING_LEVEL,
    TRANSCRIPTION_PROMPT,
    RESPONSE_SCHEMA,
};
