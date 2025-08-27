/**
 * Type definitions for the declarative scheduler.
 */

/** @typedef {import('../../time_duration/structure').TimeDuration} TimeDuration */
/** @typedef {import('../tasks').Capabilities} Capabilities */

/**
 * Main scheduler interface providing declarative task management.
 * @typedef {object} Scheduler
 * @property {Initialize} initialize - Initializes the scheduler with task registrations
 * @property {Stop} stop - Stops the scheduler and cleans up resources
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

// Re-export from task types for convenience
/** @typedef {import('./task_types').Registration} Registration */
/** @typedef {import('./task_types').ParsedRegistrations} ParsedRegistrations */
/** @typedef {import('./task_types').ParsedRegistration} ParsedRegistration */
/** @typedef {import('./task_types').Callback} Callback */
/** @typedef {import('./task_types').Task} Task */
/** @typedef {import('./task_types').CronExpression} CronExpression */
/** @typedef {import('./task_types').Transformation} Transformation */

module.exports = {
    // This module only contains type definitions, no runtime exports needed
};