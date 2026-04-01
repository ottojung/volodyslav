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

module.exports = {
    AIDiaryQuestionsError,
    isAIDiaryQuestionsError,
};
