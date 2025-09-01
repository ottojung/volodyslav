//
// Main entry point for gitstore functionality.
// This module exports the transaction function by delegating to the retry module.
//

const { transactionWithRetry } = require("./transaction_retry");

/**
 * This function performs a transaction on a Git repository.
 *
 * It gives you a temporary work tree, reset to the last commit,
 * and allows you to perform a transformation on it.
 *
 * It is atomic: if the transformation fails, the changes are not committed.
 *
 * When push fails, the entire workflow will be retried up to the configured number of attempts.
 * Non-push failures are not retried.
 *
 * @template T
 * @param {import('./transaction_retry').Capabilities} capabilities - An object containing the capabilities.
 * @param {string} workingPath - Path to the working directory (local repository)
 * @param {import('./transaction_retry').RemoteLocation | "empty"} initial_state - Remote location to sync with, or "empty" for local-only
 * @param {function(import('./transaction_attempt').GitStore): Promise<T>} transformation - A function that takes a directory path and performs some operations on it
 * @param {import('./transaction_retry').RetryOptions} [retryOptions] - Retry configuration options
 * @returns {Promise<T>}
 */
async function transaction(capabilities, workingPath, initial_state, transformation, retryOptions) {
    return await capabilities.sleeper.withMutex(workingPath, async () => {
        return await transactionWithRetry(capabilities, workingPath, initial_state, transformation, retryOptions);
    });
}

module.exports = {
    transaction,
};
