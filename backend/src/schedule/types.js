/**
 * Type definitions for the declarative scheduler.
 */

/** @typedef {import('../time_duration/structure').TimeDuration} TimeDuration */
/** @typedef {import('./tasks').Capabilities} Capabilities */

/**
 * @typedef {object} Scheduler
 * @property {Initialize} initialize - Initializes the scheduler with task registrations
 * @property {Stop} stop - Stops the scheduler and cleans up resources
 */

/**
 * Registration tuple defining a scheduled task.
 * @typedef {[string, string, () => Promise<void>, TimeDuration]} Registration
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
 * Task identity for comparison between registrations and persisted state.
 * @typedef {object} TaskIdentity
 * @property {string} name - Unique task name
 * @property {string} cronExpression - Cron expression for scheduling
 * @property {number} retryDelayMs - Retry delay in milliseconds
 */

/**
 * Configuration options for scheduler initialization.
 * @typedef {object} PollerOptions
 * @property {number} [pollIntervalMs] - The polling interval in milliseconds (default varies by implementation)
 * @example
 * // Initialize with fast polling for testing
 * await scheduler.initialize(registrations, { pollIntervalMs: 100 });
 * 
 * // Initialize with slow polling for production
 * await scheduler.initialize(registrations, { pollIntervalMs: 60000 });
 */

/**
 * Initialize function that registers tasks with the scheduler.
 * @typedef {(registrations: Array<Registration>, options?: PollerOptions) => Promise<void>} Initialize
 * @example
 * // Basic initialization
 * await scheduler.initialize([
 *   ["task1", "0 * * * *", async () => { console.log("hourly"); }, fromMinutes(5)]
 * ]);
 * 
 * // With options
 * await scheduler.initialize(registrations, { pollIntervalMs: 30000 });
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