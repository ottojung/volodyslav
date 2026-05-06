/**
 * Timeout helpers for live diary AI pipeline steps.
 *
 * @module live_diary/step_timeout
 */

const { MAX_WINDOW_PCM_BYTES } = require("./pull_window_cap");

/**
 * Conservative Whisper API upload bandwidth expressed in bytes per millisecond.
 * Represents 1 MiB per second: 1024*1024 bytes / 1000 ms.
 * At this rate the largest possible audio window (~40 MiB PCM → WAV) takes
 * roughly 40 s to upload.
 */
const WHISPER_UPLOAD_BANDWIDTH_BYTES_PER_MS = 1024 * 1024 / 1_000; // 1 MiB / 1000 ms

/**
 * Estimated Whisper generation time for the longest audio window (ms).
 * Whisper typically processes 20-minute audio in well under a minute;
 * 80 s provides a comfortable upper bound.
 */
const WHISPER_GENERATION_ESTIMATE_MS = 80_000; // 80 s

/**
 * Default per-step timeout for live diary AI pipeline steps.
 *
 * Sized for a **single** attempt of the most time-consuming step — OpenAI
 * Whisper transcription of the maximum audio window:
 *   • Upload     MAX_WINDOW_PCM_BYTES / WHISPER_UPLOAD_BANDWIDTH_BYTES_PER_MS  ≈ 40 s
 *   • Transcribe WHISPER_GENERATION_ESTIMATE_MS                                ≈ 80 s
 *
 * When MAX_WINDOW_PCM_BYTES changes (e.g. pull_window_cap.js is updated),
 * the upload term adjusts automatically.  The retry budget for each step is
 * intentionally excluded: the timeout covers one attempt, not the whole retry
 * chain.
 */
const DEFAULT_LIVE_DIARY_STEP_TIMEOUT_MS =
    Math.ceil(MAX_WINDOW_PCM_BYTES / WHISPER_UPLOAD_BANDWIDTH_BYTES_PER_MS)
    + WHISPER_GENERATION_ESTIMATE_MS;

class LiveDiaryStepTimeoutError extends Error {
    /**
     * @param {string} step
     * @param {number} timeoutMs
     */
    constructor(step, timeoutMs) {
        super(`Live diary ${step} timed out after ${timeoutMs}ms`);
        this.name = "LiveDiaryStepTimeoutError";
        this.step = step;
        this.timeoutMs = timeoutMs;
    }
}

/**
 * @param {unknown} object
 * @returns {object is LiveDiaryStepTimeoutError}
 */
function isLiveDiaryStepTimeoutError(object) {
    return object instanceof LiveDiaryStepTimeoutError;
}

/**
 * @template T
 * @param {string} step
 * @param {(signal: AbortSignal) => Promise<T>} operation
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
async function withStepTimeout(step, operation, timeoutMs) {
    const controller = new AbortController();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const timeoutError = new LiveDiaryStepTimeoutError(step, timeoutMs);
    const timeoutPromise = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            // Reject first so Promise.race settles with LiveDiaryStepTimeoutError
            // before the abort signal has a chance to cause the operation branch
            // to settle (e.g. via a fast programmatic fallback on abort).
            reject(timeoutError);
            controller.abort(timeoutError);
        }, timeoutMs);
    });
    try {
        return await Promise.race([
            operation(controller.signal),
            timeoutPromise,
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
        // Abort unconditionally so the signal is cancelled when the operation
        // succeeds normally (no-op if already aborted by the timeout path).
        controller.abort();
    }
}

module.exports = {
    DEFAULT_LIVE_DIARY_STEP_TIMEOUT_MS,
    isLiveDiaryStepTimeoutError,
    withStepTimeout,
};
