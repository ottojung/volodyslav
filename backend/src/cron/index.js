/**
 * Custom cron implementation with expression parsing and task scheduling.
 * This module provides a complete replacement for node-cron with validation.
 */

const { makeCronScheduler } = require("./scheduler");
const { parseCronExpression, isInvalidCronExpressionError } = require("./parser");
const { makeTaskId } = require("./task_id");
const datetime = require("../datetime");

/**
 * Creates a new cron scheduler with a simple schedule function.
 * Compatible with the existing node-cron interface.
 * @param {import('./scheduler').SchedulerCapabilities} capabilities
 */
function make(capabilities) {
    const scheduler = makeCronScheduler(capabilities);
    const dt = datetime.make();

    return {
        /**
         * Schedules a task with the given cron expression.
         * @param {string} cronExpression - The cron expression
         * @param {() => Promise<void> | void} callback - The callback function to execute
         * @param {import('../time_duration/structure').TimeDuration} retryDelay - The delay before retrying on error
         * @returns {import('./task_id').TaskIdClass} Task ID that can be used to cancel the task
         * @throws {Error} If the cron expression is invalid
         */
        schedule(cronExpression, callback, retryDelay) {
            return scheduler.schedule(cronExpression, callback, retryDelay);
        },

        /**
         * Cancels a scheduled task.
         * @param {import('./task_id').TaskIdClass | string} taskId - The task ID to cancel
         * @returns {boolean} True if the task was found and cancelled
         */
        cancel(taskId) {
            // Handle both TaskId objects and strings for compatibility
            const taskIdObj = typeof taskId === "string" ? makeTaskId(taskId) : taskId;
            return scheduler.cancel(taskIdObj);
        },

        /**
         * Cancels all scheduled tasks.
         * @returns {number} Number of tasks that were cancelled
         */
        cancelAll() {
            return scheduler.cancelAll();
        },

        /**
         * Gets information about all scheduled tasks.
         * @returns {Array<{id: import('./task_id').TaskIdClass, cronExpression: string, nextExecution: Date}>}
         */
        getTasks() {
            return scheduler.getTasks().map(task => ({
                ...task,
                nextExecution: dt.toNativeDate(task.nextExecution)
            }));
        }
    };
}

/**
 * Validates a cron expression without scheduling it.
 * @param {string} cronExpression - The cron expression to validate
 * @returns {boolean} True if the expression is valid
 */
function validate(cronExpression) {
    try {
        parseCronExpression(cronExpression);
        return true;
    } catch (error) {
        return false;
    }
}

module.exports = {
    make,
    validate,
    parseCronExpression,
    isInvalidCronExpressionError,
};
