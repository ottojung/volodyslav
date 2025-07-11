/**
 * Retryer system for managing retryable operations with backoff.
 * 
 * The retryer manages a set of running processes and prevents duplicate execution
 * of the same callback while allowing for retry with configurable delays.
 */

const { sleep } = require("../time_duration");

/**
 * Error thrown when retryer operations fail.
 */
class RetryerError extends Error {
    /** @type {unknown} */
    details;

    /**
     * @param {string} message
     * @param {unknown} details
     */
    constructor(message, details) {
        super(message);
        this.name = "RetryerError";
        this.details = details;
    }
}

/**
 * Type guard for RetryerError.
 * @param {unknown} object
 * @returns {object is RetryerError}
 */
function isRetryerError(object) {
    return object instanceof RetryerError;
}

/**
 * @typedef {object} RetryerCapabilities
 * @property {import('../logger').Logger} logger - Logger for retry operations
 */

/**
 * @typedef {() => Promise<import('../time_duration/structure').TimeDuration | null>} RetryableCallback
 */

/**
 * Manages running processes to prevent duplicate executions.
 */
class ProcessManager {
    /** @type {Set<RetryableCallback>} */
    #runningProcesses;

    constructor() {
        this.#runningProcesses = new Set();
    }

    /**
     * Checks if a callback is currently running.
     * @param {RetryableCallback} callback
     * @returns {boolean}
     */
    isRunning(callback) {
        return this.#runningProcesses.has(callback);
    }

    /**
     * Adds a callback to the running set.
     * @param {RetryableCallback} callback
     */
    markAsRunning(callback) {
        this.#runningProcesses.add(callback);
    }

    /**
     * Removes a callback from the running set.
     * @param {RetryableCallback} callback
     */
    markAsComplete(callback) {
        this.#runningProcesses.delete(callback);
    }

    /**
     * Gets the count of currently running processes.
     * @returns {number}
     */
    getRunningCount() {
        return this.#runningProcesses.size;
    }
}

/**
 * Creates a global process manager instance.
 * Using a singleton pattern to ensure process tracking across the application.
 */
const globalProcessManager = new ProcessManager();

/**
 * Executes a callback with retry logic based on its return value.
 * 
 * @param {RetryerCapabilities} capabilities - Required capabilities
 * @param {RetryableCallback} callback - The callback to execute
 * @returns {Promise<void>}
 * 
 * @description
 * The workflow is:
 * 0. Check if callback is running. If yes - logInfo that it is, and exit
 * 1. Put callback into the set of running processes
 * 2. Call callback
 * 3. If returns null -> remove callback from set -> full stop (done)
 * 4. If it returns a duration, sleep for that much, then try again
 */
async function withRetry(capabilities, callback) {
    // Step 0: Check if callback is already running
    if (globalProcessManager.isRunning(callback)) {
        capabilities.logger.logInfo(
            { callbackName: callback.name || 'anonymous', runningCount: globalProcessManager.getRunningCount() },
            "Retryer skipping execution - callback already running"
        );
        return;
    }

    // Step 1: Mark callback as running
    globalProcessManager.markAsRunning(callback);

    try {
        let attempt = 1;

        // eslint-disable-next-line no-constant-condition
        while (true) {
            capabilities.logger.logDebug(
                {
                    callbackName: callback.name || 'anonymous',
                    attempt,
                    runningCount: globalProcessManager.getRunningCount()
                },
                `Executing callback (attempt ${attempt})`
            );

            try {
                // Step 2: Call callback
                const result = await callback();

                // Step 3: If returns null, we're done
                if (result === null) {
                    capabilities.logger.logDebug(
                        {
                            callbackName: callback.name || 'anonymous',
                            attempt,
                            totalAttempts: attempt
                        },
                        "Callback completed successfully, no retry needed"
                    );
                    break;
                }

                // Step 4: If returns duration, sleep and retry
                capabilities.logger.logDebug(
                    {
                        callbackName: callback.name || 'anonymous',
                        attempt,
                        retryDelay: result.toString()
                    },
                    `Retryer scheduling retry after ${result.toString()}`
                );

                await sleep(result);
                attempt++;

            } catch (error) {
                // If callback throws, we stop retrying and propagate the error
                const errorMessage = error instanceof Error ? error.message : String(error);
                capabilities.logger.logDebug(
                    {
                        callbackName: callback.name || 'anonymous',
                        attempt,
                        error: errorMessage
                    },
                    "Retryer stopping retry loop due to callback error"
                );
                throw new RetryerError(`Callback failed on attempt ${attempt}: ${errorMessage}`, error);
            }
        }

    } finally {
        // Always remove from running set, even if an error occurred
        globalProcessManager.markAsComplete(callback);
        capabilities.logger.logDebug(
            {
                callbackName: callback.name || 'anonymous',
                runningCount: globalProcessManager.getRunningCount()
            },
            "Retryer removed callback from running set"
        );
    }
}

module.exports = {
    withRetry,
    isRetryerError,
};
