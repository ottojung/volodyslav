
/**
 * Type definitions for the declarative scheduler.
 */

/** @typedef {import('../../time_duration').TimeDuration} TimeDuration */
/** @typedef {import('./tasks').Capabilities} Capabilities */
/** @typedef {import('./task').Task} Task */
/** @typedef {() => Promise<void>} Callback */
/** @typedef {import('./expression').CronExpression} CronExpression */

/**
 * @typedef {object} Scheduler
 * @property {Initialize} initialize - Initializes the scheduler with task registrations
 * @property {Stop} stop - Stops the scheduler and cleans up resources
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
 * @typedef {object} ParsedRegistration
 * @property {string} name
 * @property {CronExpression} parsedCron
 * @property {Callback} callback
 * @property {TimeDuration} retryDelay
 */

/**
 * @typedef {Map<string, ParsedRegistration>} ParsedRegistrations
 */

/**
 * @template T
 * @typedef {(tasks: Map<string, Task>) => T} Transformation
 */

/**
 * Task identity for comparison between registrations and persisted state.
 * @typedef {object} TaskIdentity
 * @property {string} name - Unique task name
 * @property {string} cronExpression - Cron expression for scheduling
 * @property {number} retryDelayMs - Retry delay in milliseconds
 */

/**
 * Initialize function that registers tasks with the scheduler.
 * @typedef {(registrations: Array<Registration>) => Promise<void>} Initialize
 * @example
 * // Initialize the scheduler
 * await scheduler.initialize([
 *   ["task1", "0 * * * *", async () => { console.log("hourly"); }, fromMinutes(5)]
 * ]);
 */

/**
 * Stop function that gracefully shuts down the scheduler.
 * @typedef {() => Promise<void>} Stop
 * @example
 * // Graceful shutdown
 * await scheduler.stop();
 */

module.exports = {
    // This module only contains type definitions, no runtime exports needed
};
