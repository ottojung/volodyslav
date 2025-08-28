// @ts-check
/**
 * Constants for the scheduler.
 */

/**
 * Default poll interval in milliseconds.
 */
const DEFAULT_POLL_INTERVAL_MS = 60000; // 1 minute

/**
 * Current state schema version.
 */
const CURRENT_STATE_VERSION = "1.0";

/**
 * Maximum task name length.
 */
const MAX_TASK_NAME_LENGTH = 100;

/**
 * Maximum retry delay in milliseconds.
 */
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Minimum retry delay in milliseconds.
 */
const MIN_RETRY_DELAY_MS = 0; // Allow immediate retries for compatibility

/**
 * Maximum cron calculation iterations.
 */
const MAX_CRON_ITERATIONS = 366 * 24 * 60; // One year worth of minutes

module.exports = {
    DEFAULT_POLL_INTERVAL_MS,
    CURRENT_STATE_VERSION,
    MAX_TASK_NAME_LENGTH,
    MAX_RETRY_DELAY_MS,
    MIN_RETRY_DELAY_MS,
    MAX_CRON_ITERATIONS,
};