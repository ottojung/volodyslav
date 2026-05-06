/**
 * Timeout helpers for live diary AI pipeline steps.
 *
 * @module live_diary/step_timeout
 */

/**
 * Default per-step timeout for live diary AI pipeline steps.
 *
 * This value must be long enough to accommodate the most time-consuming step:
 * audio transcription via the Gemini API.  A single transcription attempt
 * involves:
 *   • File upload            – up to ~30 s for a 40 MiB WAV
 *   • File activation poll   – up to 30 s (FILE_ACTIVATION_MAX_ATTEMPTS × 1 s)
 *   • Model generation       – up to ~60 s for a 20-minute audio window
 * Total for one attempt: ~120 s.  With up to 4 retries on transient errors
 * (RETRY_MAX_ATTEMPTS in transcription_gemini.js) the overall cost can reach
 * several minutes.
 *
 * 5 minutes (300 s) covers the realistic tail of single-attempt latency while
 * still protecting against genuinely hung API connections.
 */
const DEFAULT_LIVE_DIARY_STEP_TIMEOUT_MS = 5 * 60_000; // 5 minutes

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
    /** @type {NodeJS.Timeout | undefined} */
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
