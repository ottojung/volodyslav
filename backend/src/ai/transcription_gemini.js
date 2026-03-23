"use strict";

const { fromMilliseconds } = require("../datetime");

/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../sleeper').SleepCapability} SleepCapability */

/**
 * @typedef {object} RetryCapabilities
 * @property {Logger} logger - A logger instance.
 * @property {SleepCapability} sleeper - A sleeper instance.
 */

/**
 * @typedef {object} UploadedGeminiFile
 * @property {string | undefined} [uri]
 * @property {string | undefined} [mimeType]
 * @property {string | undefined} [name]
 * @property {string | { name?: string } | undefined} [state]
 */

const RETRYABLE_HTTP_STATUS_CODES = [429, 500, 503, 504];
const RETRYABLE_ERROR_CODES = ["RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE", "DEADLINE_EXCEEDED"];
const RETRY_MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 4000;
const FILE_ACTIVATION_MAX_ATTEMPTS = 30;
const FILE_ACTIVATION_POLL_DELAY_MS = 1000;

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
 * @param {RetryCapabilities} capabilities
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
 * @param {RetryCapabilities} capabilities
 * @param {{ files: { get: (args: { name: string }) => Promise<UploadedGeminiFile> } }} ai - GoogleGenAI instance
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

module.exports = {
    AITranscriptionError,
    isAITranscriptionError,
    extractStatusCode,
    extractErrorCode,
    isRetryableGeminiError,
    withGeminiTransientRetry,
    waitForUploadedFileToBeActive,
};
