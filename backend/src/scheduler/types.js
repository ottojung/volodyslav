
/**
 * Type definitions for the declarative scheduler.
 */

/** @typedef {import('../datetime').Duration} Duration */
/** @typedef {import('./task').Task} Task */
/** @typedef {import('../runtime_state_storage').TaskRecord} TaskRecord */
/** @typedef {import('../runtime_state_storage').RuntimeState} RuntimeState */
/** @typedef {() => Promise<void>} Callback */
/** @typedef {import('./expression').CronExpression} CronExpression */
/** @typedef {import('./task').TaskTryDeserializeError} TaskTryDeserializeError */
/** @typedef {import('./task').SerializedTask} SerializedTask */

/**
 * Restricted capabilities needed by the scheduler.
 * Only includes the minimal set of capabilities actually used by the scheduler.
 * @typedef {object} SchedulerCapabilities
 * @property {import('../datetime').Datetime} datetime - Datetime utilities
 * @property {import('../logger').Logger} logger - A logger instance
 * @property {import('../runtime_state_storage').RuntimeStateCapability} state - A runtime state storage instance
 * @property {import('../random/seed').NonDeterministicSeed} seed - A random number generator instance
 * @property {import('../sleeper').SleepCapability} sleeper - A sleeper instance
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
 * @template T
 * @typedef {(tasks: TaskRecord[]) => T} RecordTransformation
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
