/**
 * Timeout helpers for live diary AI pipeline steps.
 *
 * @module live_diary/step_timeout
 */

const {
    FILE_ACTIVATION_MAX_ATTEMPTS,
    FILE_ACTIVATION_POLL_DELAY_MS,
} = require("../ai");

/**
 * Estimated time for a single Gemini transcription attempt, excluding the
 * file-activation polling (which is accounted for via the named constants).
 * Covers the file-upload round-trip and the model generation phase.
 */
const UPLOAD_AND_GENERATION_ESTIMATE_MS = 90_000; // ~90 s

/**
 * Default per-step timeout for live diary AI pipeline steps.
 *
 * Sized for a **single** attempt of the most time-consuming step — Gemini
 * audio transcription:
 *   • File activation poll  FILE_ACTIVATION_MAX_ATTEMPTS × FILE_ACTIVATION_POLL_DELAY_MS
 *   • Upload + generation   UPLOAD_AND_GENERATION_ESTIMATE_MS
 *
 * When the referenced constants change, this value adjusts automatically.
 * The retry budget for each step (e.g. RETRY_MAX_ATTEMPTS in
 * transcription_gemini.js) is intentionally excluded: the timeout covers
 * one run, not the whole retry chain.
 */
const DEFAULT_LIVE_DIARY_STEP_TIMEOUT_MS =
    FILE_ACTIVATION_MAX_ATTEMPTS * FILE_ACTIVATION_POLL_DELAY_MS
    + UPLOAD_AND_GENERATION_ESTIMATE_MS;

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
