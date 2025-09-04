
/**
 * Type definitions for the declarative scheduler.
 */

/** @typedef {import('luxon').Duration} Duration */
/** @typedef {import('../capabilities/root').Capabilities} Capabilities */
/** @typedef {import('./task').Task} Task */
/** @typedef {() => Promise<void>} Callback */
/** @typedef {import('./expression').CronExpression} CronExpression */

/**
 * Minimal capabilities interface for the scheduler.
 * This provides only the capabilities actually needed by the scheduler,
 * following the principle of least privilege.
 * @typedef {object} SchedulerCapabilities
 * @property {import('../logger').Logger} logger - For logging operations
 * @property {import('../datetime').Datetime} datetime - For time operations
 * @property {import('../runtime_state_storage').RuntimeStateStorage} state - For persistence
 * @property {import('../threading').Threading} threading - For periodic operations
 */

/**
 * @typedef {object} Scheduler
 * @property {Initialize} initialize - Initializes the scheduler with task registrations
 * @property {Stop} stop - Stops the scheduler and cleans up resources
 */

/**
 * Registration tuple defining a scheduled task.
 * @typedef {[string, string, Callback, Duration]} Registration
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
 * @property {Duration} retryDelay
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
