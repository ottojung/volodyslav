
/**
 * @typedef {import('../../time_duration').TimeDuration} TimeDuration
 */

/** 
 * @typedef {import('../polling_scheduler').Task} Task
 */

/**
 * @typedef {(tasks: Map<string, Task>) => Map<string, Task>} Transformation
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

module.exports = {};
