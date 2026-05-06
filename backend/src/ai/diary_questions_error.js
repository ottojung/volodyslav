class AIDiaryQuestionsError extends Error {
    /**
     * @param {string} message
     * @param {unknown} cause
     */
    constructor(message, cause) {
        super(message);
        this.name = "AIDiaryQuestionsError";
        this.cause = cause;
    }
}

/**
 * Checks if the error is an AIDiaryQuestionsError.
 * @param {unknown} object - The error to check.
 * @returns {object is AIDiaryQuestionsError}
 */
function isAIDiaryQuestionsError(object) {
    return object instanceof AIDiaryQuestionsError;
}

class AIDiaryQuestionsCallTimeoutError extends AIDiaryQuestionsError {
    /**
     * @param {number} transcriptLength - Character length of the transcript input.
     * @param {number} maxQuestions - Maximum questions requested.
     * @param {number} timeoutMs - The timeout duration that was exceeded.
     */
    constructor(transcriptLength, maxQuestions, timeoutMs) {
        super(
            `Diary question generation timed out after ${timeoutMs}ms (transcript length ${transcriptLength}, max questions ${maxQuestions})`,
            undefined
        );
        this.name = "AIDiaryQuestionsCallTimeoutError";
        this.transcriptLength = transcriptLength;
        this.maxQuestions = maxQuestions;
        this.timeoutMs = timeoutMs;
    }
}

/**
 * Checks if the error is an AIDiaryQuestionsCallTimeoutError.
 * @param {unknown} object - The error to check.
 * @returns {object is AIDiaryQuestionsCallTimeoutError}
 */
function isAIDiaryQuestionsCallTimeoutError(object) {
    return object instanceof AIDiaryQuestionsCallTimeoutError;
}

module.exports = {
    AIDiaryQuestionsError,
    isAIDiaryQuestionsError,
    AIDiaryQuestionsCallTimeoutError,
    isAIDiaryQuestionsCallTimeoutError,
};
