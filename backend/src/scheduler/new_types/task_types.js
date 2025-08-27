/**
 * Task-specific type definitions for the scheduler.
 */

/** @typedef {import('../../time_duration').TimeDuration} TimeDuration */

/**
 * Async callback function for scheduled tasks.
 * @typedef {() => Promise<void>} Callback
 */

/**
 * Parsed cron expression with validation metadata.
 * @typedef {import('../new_cron/parser').CronExpression} CronExpression
 */

/**
 * Task object representing scheduled task state.
 * @typedef {import('../internal/task/structure').Task} Task
 */

/**
 * Registration tuple defining a scheduled task.
 * @typedef {[string, string, Callback, TimeDuration]} Registration
 * @example
 * // Schedule a daily backup task at 2 AM
 * const registration = [
 *   "daily-backup",           // Task name (must be unique)
 *   "0 2 * * *",             // Cron expression (daily at 2:00 AM)
 *   async () => { ... },     // Async callback function
 *   fromMinutes(30)          // Retry delay (30 minutes)
 * ];
 */

/**
 * Parsed registration with validated components.
 * @typedef {object} ParsedRegistration
 * @property {string} name - Unique task name
 * @property {CronExpression} parsedCron - Parsed and validated cron expression
 * @property {Callback} callback - Async callback function
 * @property {TimeDuration} retryDelay - Retry delay duration
 */

/**
 * Map of parsed registrations keyed by task name.
 * @typedef {Map<string, ParsedRegistration>} ParsedRegistrations
 */

/**
 * Function that operates on a collection of tasks and returns a result.
 * @template T
 * @typedef {(tasks: Map<string, Task>) => T} Transformation
 */

module.exports = {
    // This module only contains type definitions, no runtime exports needed
};