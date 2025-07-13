/**
 * Retryer system for managing retryable operations with backoff.
 * 
 * The retryer manages a set of running processes and prevents duplicate execution
 * of the same callback while allowing for retry with configurable delays.
 */


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
 * @property {import('../sleeper').Sleeper} sleeper - Sleeper capability
 */

/**
 * @typedef {RetryableCallbackClass} RetryableCallback
 */

/**
 * Manages running processes to prevent duplicate executions.
 */
class ProcessManager {
    /** @type {Set<string>} */
    #runningProcesses;

    constructor() {
        this.#runningProcesses = new Set();
    }

    /**
     * Checks if a callback is currently running.
     * @param {RetryableCallback} retryableCallback
     * @returns {boolean}
     */
    isRunning(retryableCallback) {
        return this.#runningProcesses.has(retryableCallback.name);
    }

    /**
     * Adds a callback to the running set.
     * @param {RetryableCallback} retryableCallback
     */
    markAsRunning(retryableCallback) {
        this.#runningProcesses.add(retryableCallback.name);
    }

    /**
     * Removes a callback from the running set.
     * @param {RetryableCallback} retryableCallback
     */
    markAsComplete(retryableCallback) {
        this.#runningProcesses.delete(retryableCallback.name);
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
 * @param {RetryableCallback} retryableCallback - The retryable callback structure to execute
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
async function withRetry(capabilities, retryableCallback) {
    // Step 0: Check if callback is already running
    if (globalProcessManager.isRunning(retryableCallback)) {
        capabilities.logger.logInfo(
            { callbackName: retryableCallback.name, runningCount: globalProcessManager.getRunningCount() },
            "Retryer skipping execution - callback already running"
        );
        return;
    }

    // Step 1: Mark callback as running
    globalProcessManager.markAsRunning(retryableCallback);

    try {
        let attempt = 1;

        // eslint-disable-next-line no-constant-condition
        while (true) {
            capabilities.logger.logDebug(
                {
                    callbackName: retryableCallback.name,
                    attempt,
                    runningCount: globalProcessManager.getRunningCount()
                },
                `Executing callback (attempt ${attempt})`
            );

            try {
                // Step 2: Call callback
                const result = await retryableCallback.callback();

                // Step 3: If returns null, we're done
                if (result === null) {
                    capabilities.logger.logDebug(
                        {
                            callbackName: retryableCallback.name,
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
                        callbackName: retryableCallback.name,
                        attempt,
                        retryDelay: result.toString()
                    },
                    `Retryer scheduling retry after ${result.toString()}`
                );

                await capabilities.sleeper.sleep(result.toMilliseconds());
                attempt++;

            } catch (error) {
                // If callback throws, we stop retrying and propagate the error
                const errorMessage = error instanceof Error ? error.message : String(error);
                capabilities.logger.logDebug(
                    {
                        callbackName: retryableCallback.name,
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
        globalProcessManager.markAsComplete(retryableCallback);
        capabilities.logger.logDebug(
            {
                callbackName: retryableCallback.name,
                runningCount: globalProcessManager.getRunningCount()
            },
            "Retryer removed callback from running set"
        );
    }
}

/**
 * Creates a RetryableCallback structure.
 * 
 * @param {string} name - A unique name identifier for the callback
 * @param {() => Promise<import('../time_duration/structure').TimeDuration | null>} callback - The callback function to execute
 * @returns {RetryableCallback}
 */
function makeRetryableCallback(name, callback) {
    return new RetryableCallbackClass(name, callback);
}

/**
 * RetryableCallback class for nominal typing.
 */
class RetryableCallbackClass {
    /** @type {undefined} */
    __brand = undefined; // nominal typing brand
    
    /** @type {string} */
    name;
    
    /** @type {() => Promise<import('../time_duration/structure').TimeDuration | null>} */
    callback;

    /**
     * @param {string} name
     * @param {() => Promise<import('../time_duration/structure').TimeDuration | null>} callback
     */
    constructor(name, callback) {
        if (this.__brand !== undefined) {
            throw new Error("RetryableCallback is a nominal type");
        }
        this.name = name;
        this.callback = callback;
    }
}

/**
 * Type guard for RetryableCallback.
 * @param {unknown} object
 * @returns {object is RetryableCallbackClass}
 */
function isRetryableCallback(object) {
    return object instanceof RetryableCallbackClass;
}

module.exports = {
    withRetry,
    isRetryerError,
    makeRetryableCallback,
    isRetryableCallback,
};
