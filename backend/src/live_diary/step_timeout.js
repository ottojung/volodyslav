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
 * @param {() => Promise<T>} operation
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
async function withStepTimeout(step, operation, timeoutMs) {
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const timeoutPromise = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new LiveDiaryStepTimeoutError(step, timeoutMs));
        }, timeoutMs);
    });
    try {
        return await Promise.race([
            operation(),
            timeoutPromise,
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

module.exports = {
    DEFAULT_LIVE_DIARY_STEP_TIMEOUT_MS,
    isLiveDiaryStepTimeoutError,
    withStepTimeout,
};
