/**
 * Retryer module for managing retryable operations with backoff.
 * Follows the project's encapsulation pattern where only specific functions are exported.
 */

const { withRetry } = require("./core");

module.exports = {
    withRetry,
};
