//
// This module handles retry logic for gitstore transactions.
//

const { isPushError } = require("./wrappers");
const { executeTransactionAttempt } = require("./transaction_attempt");
const { fromMilliseconds } = require("../datetime");
const {
    logTransactionAttemptStart,
    logTransactionSuccessAfterRetries,
    logNonRetryableError,
    logRetryAttempt,
    logFinalFailure,
} = require("./transaction_logging");
const { withRetry } = require("../retryer");

/** @typedef {import('./transaction_logging').TransactionLoggingContext} TransactionLoggingContext */

/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../sleeper').Sleeper} Sleeper */
/** @typedef {import('../datetime').Datetime} Datetime */
/** @typedef {import('./transaction_attempt').GitStore} GitStore */

/**
 * @typedef {object} RemoteLocation
 * @property {string} url - The URL or path to the remote repository
 */

/**
 * @typedef {object} Capabilities
 * @property {Command} git - A command instance for Git operations.
 * @property {FileCreator} creator - A file creator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {Datetime} datetime - Datetime utilities.
 * @property {Sleeper} sleeper - A sleeper instance.
 */

/**
 * @typedef {object} RetryOptions
 * @property {number} maxAttempts - Maximum number of retry attempts
 * @property {number} delayMs - Delay in milliseconds
 */

/**
 * Default retry configuration
 * @type {RetryOptions}
 */
const DEFAULT_RETRY_OPTIONS = {
    maxAttempts: 5,
    delayMs: 0,
};

/**
 * Get initial state description for logging.
 * @param {RemoteLocation | "empty"} initial_state - The initial state
 * @returns {string} - Description suitable for logging
 */
function getInitialStateDescription(initial_state) {
    return initial_state === "empty" ? "empty" : initial_state.url;
}

/**
 * Creates a logging context for transaction operations.
 * @param {number} attempt - Current attempt number
 * @param {number} maxAttempts - Maximum number of attempts
 * @param {string} workingPath - Path to the working directory
 * @param {RemoteLocation | "empty"} initial_state - Initial state
 * @returns {TransactionLoggingContext} - Logging context
 */
function createLoggingContext(attempt, maxAttempts, workingPath, initial_state) {
    return {
        attempt,
        maxAttempts,
        workingPath,
        initialStateDescription: getInitialStateDescription(initial_state),
    };
}

/**
 * Execute a transaction with retry logic.
 * 
 * This function performs a transaction on a Git repository with automatic retry
 * on push failures. It gives you a temporary work tree, reset to the last commit,
 * and allows you to perform a transformation on it.
 *
 * It is atomic: if the transformation fails, the changes are not committed.
 * Caveat: if you are calling commit() multiple times, they won't necessarily be consecutive.
 *
 * When push fails, the entire workflow will be retried up to the configured number of attempts.
 * Non-push failures are not retried.
 *
 * @template T
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {string} workingPath - Path to the working directory (local repository)
 * @param {RemoteLocation | "empty"} initial_state - Remote location to sync with, or "empty" for local-only
 * @param {function(GitStore): Promise<T>} transformation - A function that takes a directory path and performs some operations on it
 * @param {RetryOptions} [retryOptions] - Retry configuration options
 * @returns {Promise<T>}
 */
async function transactionWithRetry(capabilities, workingPath, initial_state, transformation, retryOptions = DEFAULT_RETRY_OPTIONS) {
    const options = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
    const delayMs = options.delayMs;
    const delay = fromMilliseconds(delayMs);
    const callbackName = `transaction:${workingPath}`;

    return withRetry(capabilities, callbackName, async ({ attempt, retry }) => {
        const loggingContext = createLoggingContext(attempt, options.maxAttempts, workingPath, initial_state);

        logTransactionAttemptStart(capabilities.logger, loggingContext);

        try {
            const result = await executeTransactionAttempt(capabilities, workingPath, initial_state, transformation);

            if (attempt > 1) {
                logTransactionSuccessAfterRetries(capabilities.logger, loggingContext);
            }

            return result;
        } catch (error) {
            if (!isPushError(error)) {
                logNonRetryableError(capabilities.logger, loggingContext, error);
                throw error;
            }

            if (attempt >= options.maxAttempts) {
                logFinalFailure(capabilities.logger, loggingContext, error);
                throw error;
            }

            logRetryAttempt(capabilities.logger, loggingContext, delay.toString() || `${delayMs}ms`, error);
            await capabilities.sleeper.sleep(delay);
            return retry();
        }
    });
}

module.exports = {
    transactionWithRetry,
    DEFAULT_RETRY_OPTIONS,
};
