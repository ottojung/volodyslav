//
// This module provides centralized logging functionality for gitstore transactions.
//

/** @typedef {import('../logger').Logger} Logger */

/**
 * @typedef {object} TransactionLoggingContext
 * @property {number} attempt - Current attempt number
 * @property {number} maxAttempts - Maximum number of attempts
 * @property {string} workingPath - Path to the working directory
 * @property {string} initialStateDescription - Description of initial state
 */

/**
 * Log the start of a transaction attempt.
 * @param {Logger} logger - The logger instance
 * @param {TransactionLoggingContext} context - Logging context
 * @returns {void}
 */
function logTransactionAttemptStart(logger, context) {
    logger.logDebug(
        {
            attempt: context.attempt,
            maxAttempts: context.maxAttempts,
            workingPath: context.workingPath,
            initialState: context.initialStateDescription
        },
        `Gitstore transaction attempt ${context.attempt}/${context.maxAttempts}`
    );
}

/**
 * Log successful transaction after retries.
 * @param {Logger} logger - The logger instance
 * @param {TransactionLoggingContext} context - Logging context
 * @returns {void}
 */
function logTransactionSuccessAfterRetries(logger, context) {
    logger.logInfo(
        {
            attempt: context.attempt,
            totalAttempts: context.attempt,
            workingPath: context.workingPath
        },
        `Gitstore transaction succeeded on attempt ${context.attempt} after previous failures`
    );
}

/**
 * Log non-retryable error.
 * @param {Logger} logger - The logger instance
 * @param {TransactionLoggingContext} context - Logging context
 * @param {unknown} error - The error that occurred
 * @returns {void}
 */
function logNonRetryableError(logger, context, error) {
    logger.logDebug(
        {
            attempt: context.attempt,
            errorType: error instanceof Error ? error.name : 'Unknown',
            errorMessage: error instanceof Error ? error.message : String(error),
            workingPath: context.workingPath
        },
        `Gitstore transaction failed with non-push error - not retrying`
    );
}

/**
 * Log retry attempt after push failure.
 * @param {Logger} logger - The logger instance
 * @param {TransactionLoggingContext} context - Logging context
 * @param {string} delayDescription - Description of the retry delay
 * @param {unknown} error - The error that occurred
 * @returns {void}
 */
function logRetryAttempt(logger, context, delayDescription, error) {
    logger.logInfo(
        {
            attempt: context.attempt,
            maxAttempts: context.maxAttempts,
            retryDelay: delayDescription,
            errorMessage: error instanceof Error ? error.message : String(error),
            workingPath: context.workingPath
        },
        `Gitstore push failed on attempt ${context.attempt} - retrying after ${delayDescription}`
    );
}

/**
 * Log final failure after all retries exhausted.
 * @param {Logger} logger - The logger instance
 * @param {TransactionLoggingContext} context - Logging context
 * @param {unknown} error - The error that occurred
 * @returns {void}
 */
function logFinalFailure(logger, context, error) {
    logger.logError(
        {
            attempt: context.attempt,
            maxAttempts: context.maxAttempts,
            errorMessage: error instanceof Error ? error.message : String(error),
            workingPath: context.workingPath
        },
        `Gitstore transaction failed after ${context.maxAttempts} attempts - giving up`
    );
}

module.exports = {
    logTransactionAttemptStart,
    logTransactionSuccessAfterRetries,
    logNonRetryableError,
    logRetryAttempt,
    logFinalFailure,
};