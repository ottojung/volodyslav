/**
 * Retryer module for managing retryable operations with backoff.
 * Follows the project's encapsulation pattern where only specific functions are exported.
 */

const { withRetry, isRetryerError, makeRetryableCallback, isRetryableCallback } = require("./core");

module.exports = {
    withRetry,
    isRetryerError,
    makeRetryableCallback,
    isRetryableCallback,
};
