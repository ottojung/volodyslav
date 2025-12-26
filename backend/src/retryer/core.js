
/**
 * @typedef {object} RetryerCapabilities
 * @property {import('../logger').Logger} logger - Logger for retry operations
 * @property {import('../datetime').Datetime} datetime - Date capability
 */

const { difference } = require("../datetime");

/** @typedef {import('../datetime').Duration} Duration */

/**
 * @template T
 * @typedef {(args: {attempt: number, timePassed: () => Duration, retry: () => RetryToken}) => Promise<T | RetryToken>} RetryableCallback
 */

class RetryToken {
}

/**
 * @param {unknown} value
 * @returns {value is RetryToken}
 */
function isRetryToken(value) {
    return value instanceof RetryToken;
}

class UnexpectedRetryTokenError extends Error {
    /**
     * @param {string} callbackName
     */
    constructor(callbackName) {
        super(`Retry token returned unexpectedly in callback ${callbackName}`);
        this.name = "UnexpectedRetryTokenError";
        this.callbackName = callbackName;
    }
}

/**
 * @param {unknown} value
 * @returns {value is UnexpectedRetryTokenError}
 */
function isUnexpectedRetryTokenError(value) {
    return value instanceof UnexpectedRetryTokenError;
}

/**
 * Executes a callback with retry logic based on its return value.
 * 
 * @template T
 * @param {RetryerCapabilities} capabilities - Required capabilities
 * @param {string} callbackName - A unique name for the callback, used for logging
 * @param {RetryableCallback<T>} retryableCallback - The retryable callback structure to execute
 * @returns {Promise<T>}
 * 
 * @description
 * The workflow is:
 * 0. Check if callback is running. If yes - logInfo that it is, and exit
 * 1. Put callback into the set of running processes
 * 2. Call callback
 * 3. If returns null -> remove callback from set -> full stop (done)
 * 4. If it returns a duration, sleep for that much, then try again
 */
async function withRetry(capabilities, callbackName, retryableCallback) {
    const quotedCallbackName = JSON.stringify(callbackName);
    const startTime = capabilities.datetime.now();
    let attempt = 1;
    let toBeRetried = true;

    /**
     * Retry the operation.
     * @returns {RetryToken}
     */
    function retry() {
        toBeRetried = true;
        return new RetryToken();
    }

    function timePassed() {
        const current = capabilities.datetime.now();
        return difference(current, startTime);
    }

    for (;;) {
        capabilities.logger.logDebug(
            {
                callbackName,
                attempt,
            },
            `Executing callback ${quotedCallbackName} (attempt ${attempt})`
        );

        toBeRetried = false;
        const result = await retryableCallback({
            attempt,
            timePassed,
            retry,
        });

        if (toBeRetried === false) {
            if (isRetryToken(result)) {
                throw new UnexpectedRetryTokenError(callbackName);
            }
            capabilities.logger.logDebug(
                {
                    callbackName,
                    attempt,
                    totalAttempts: attempt
                },
                `Callback ${quotedCallbackName} completed successfully`
            );
            return result;
        }

        attempt++;
    }
}

module.exports = {
    withRetry,
    isUnexpectedRetryTokenError,
};
