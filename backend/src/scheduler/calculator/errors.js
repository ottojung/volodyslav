/**
 * Error classes for cron calculation failures.
 * These errors are defined close to where they are thrown.
 */

/**
 * Error thrown when no valid execution time can be found for a cron expression.
 * This indicates that the cron expression is incorrect or impossible to satisfy.
 */
class CronCalculationError extends Error {
    /**
     * @param {string} message - Error message
     * @param {object} [details] - Additional error details
     */
    constructor(message, details) {
        super(message);
        this.name = "CronCalculationError";
        this.details = details;
    }
}

/**
 * @param {unknown} object
 * @returns {object is CronCalculationError}
 */
function isCronCalculationError(object) {
    return object instanceof CronCalculationError;
}

module.exports = {
    CronCalculationError,
    isCronCalculationError,
};