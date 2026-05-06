/**
 * Shared transcription helper for the live diary pull pipeline.
 *
 * Used by the pull pipeline (`pull_helpers.js`) so the implementation stays
 * in one place.
 *
 * File I/O is performed through the capabilities pattern (creator / writer /
 * reader / deleter) so that the helper is testable without touching the real
 * filesystem.
 *
 * @module live_diary/transcribe_utils
 */

const path = require("path");
const { extensionForMime } = require("./wav_utils");

const TRANSCRIPTION_UPLOAD_BYTES_PER_MS = 1024 * 1024 / 1_000;
const TRANSCRIPTION_GENERATION_BASE_MS = 30_000;
const TRANSCRIPTION_MAX_GENERATION_MS = 80_000;
const TRANSCRIPTION_TIMEOUT_PADDING_MS = 10_000;

/** @typedef {import('../ai/transcription').AITranscription} AITranscription */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */

/**
 * @typedef {object} TranscribeCapabilities
 * @property {AITranscription} aiTranscription
 * @property {Logger} logger
 * @property {FileCreator} creator
 * @property {FileWriter} writer
 * @property {FileReader} reader
 * @property {FileDeleter} deleter
 */

/**
 * @param {number} audioBytes
 * @returns {number}
 */
function computeTranscriptionTimeoutMs(audioBytes) {
    const uploadMs = Math.ceil(audioBytes / TRANSCRIPTION_UPLOAD_BYTES_PER_MS);
    const generationMs = Math.min(
        TRANSCRIPTION_MAX_GENERATION_MS,
        TRANSCRIPTION_GENERATION_BASE_MS + Math.ceil(uploadMs / 2)
    );
    return uploadMs + generationMs + TRANSCRIPTION_TIMEOUT_PADDING_MS;
}

class LiveDiaryTranscriptionTimeoutError extends Error {
    /**
     * @param {number} timeoutMs
     */
    constructor(timeoutMs) {
        super(`Live diary transcription timed out after ${timeoutMs}ms`);
        this.name = "LiveDiaryTranscriptionTimeoutError";
        this.timeoutMs = timeoutMs;
    }
}

/**
 * @param {unknown} object
 * @returns {object is LiveDiaryTranscriptionTimeoutError}
 */
function isLiveDiaryTranscriptionTimeoutError(object) {
    return object instanceof LiveDiaryTranscriptionTimeoutError;
}

/**
 * @param {AbortSignal} signal
 * @param {AbortController} timeoutController
 * @returns {() => void}
 */
function connectTimeoutAbort(signal, timeoutController) {
    const abortDueToSignal = () => {
        timeoutController.abort(signal.reason);
    };

    if (signal.aborted) {
        abortDueToSignal();
        return () => {};
    }

    signal.addEventListener("abort", abortDueToSignal, { once: true });
    return () => {
        signal.removeEventListener("abort", abortDueToSignal);
    };
}

/**
 * Write a Buffer to a named temp file, transcribe it, then delete the temp file.
 * Returns the raw transcript string (trimmed).
 * @param {Buffer} audioBuffer
 * @param {string} mimeType
 * @param {TranscribeCapabilities} capabilities
 * @param {AbortSignal} signal - Abort signal forwarded to the Whisper API call.
 * @returns {Promise<string>}
 */
async function transcribeBuffer(audioBuffer, mimeType, capabilities, signal) {
    const ext = extensionForMime(mimeType);
    const tmpDir = await capabilities.creator.createTemporaryDirectory();

    try {
        const tmpFile = await capabilities.creator.createFile(
            path.join(tmpDir, `diary.${ext}`)
        );
        await capabilities.writer.writeBuffer(tmpFile, audioBuffer);

        const fileStream = capabilities.reader.createReadStream(tmpFile);

        await new Promise((resolve, reject) => {
            fileStream.once("open", resolve);
            fileStream.once("error", reject);
        });

        let result;
        const timeoutMs = computeTranscriptionTimeoutMs(audioBuffer.length);
        const timeoutError = new LiveDiaryTranscriptionTimeoutError(timeoutMs);
        const timeoutController = new AbortController();
        const disconnectAbortForwarding = connectTimeoutAbort(signal, timeoutController);

        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        const timeoutPromise = new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                timeoutController.abort(timeoutError);
                reject(timeoutError);
                fileStream.destroy(timeoutError);
            }, timeoutMs);
        });
        try {
            result = await Promise.race([
                capabilities.aiTranscription.transcribeStreamPreciseDetailed(
                    fileStream,
                    timeoutController.signal
                ),
                timeoutPromise,
            ]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            disconnectAbortForwarding();
            fileStream.destroy();
        }

        return result.structured.transcript.trim();
    } finally {
        capabilities.deleter.deleteDirectory(tmpDir).catch(() => {
            // Best-effort cleanup.
        });
    }
}

module.exports = {
    computeTranscriptionTimeoutMs,
    isLiveDiaryTranscriptionTimeoutError,
    transcribeBuffer,
};
