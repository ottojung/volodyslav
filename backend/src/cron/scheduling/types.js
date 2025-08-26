
/**
 * @typedef {import('../../time_duration').TimeDuration} TimeDuration
 * @typedef {import('../polling_scheduler').Task} Task
 * @typedef {(tasks: Map<string, Task>) => Map<string, Task>} Transformation
 * @typedef {() => Promise<void>} Callback
 * @typedef {import('../expression').CronExpression} CronExpression
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
 * @property {CronExpression} cronExpression
 * @property {Callback} callback
 * @property {TimeDuration} retryDelay
 */

/**
 * @typedef {Map<string, ParsedRegistration>} ParsedRegistrations
 */

module.exports = {};
