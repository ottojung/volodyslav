/**
 * Timeout helpers for live diary AI pipeline steps.
 *
 * @module live_diary/step_timeout
 */

const DEFAULT_LIVE_DIARY_STEP_TIMEOUT_MS = 12000;

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
            controller.abort(timeoutError);
            reject(timeoutError);
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
