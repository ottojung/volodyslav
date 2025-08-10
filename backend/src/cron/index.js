/**
 * Polling cron scheduler public interface.
 */

const { makePollingScheduler } = require("./polling_scheduler");
const { parseCronExpression, isInvalidCronExpressionError } = require("./parser");
const {
    ScheduleDuplicateTaskError,
    isScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
    isScheduleInvalidNameError,
} = require("./polling_scheduler_errors");

/**
 * Creates a new polling scheduler instance.
 * @param {import('../capabilities/root').Capabilities} capabilities
 * @param {{pollIntervalMs?: number}} [options]
 */
function make(capabilities, options = {}) {
    const scheduler = makePollingScheduler(capabilities, options);
    return {
        /**
         * Schedule a task.
         * @param {string} name
         * @param {string} cronExpression
         * @param {() => Promise<void> | void} callback
         * @param {import('../time_duration/structure').TimeDuration} retryDelay
         * @returns {string}
         */
        schedule(name, cronExpression, callback, retryDelay) {
            return scheduler.schedule(name, cronExpression, callback, retryDelay);
        },

        /**
         * Cancel a task by name.
         * @param {string} name
         * @returns {boolean}
         */
        cancel(name) {
            return scheduler.cancel(name);
        },
        /**
         * Cancel all tasks and stop polling.
         * @returns {number}
         */
        cancelAll() {
            return scheduler.cancelAll();
        },
        /**
         * Get info about tasks.
         */
        getTasks() {
            return scheduler.getTasks();
        },
        /**
         * Validate a cron expression.
         * @param {string} cronExpression
         * @returns {boolean}
         */
        validate(cronExpression) {
            try {
                parseCronExpression(cronExpression);
                return true;
            } catch {
                return false;
            }
        },
    };
}

/**
 * Validate a cron expression without creating a scheduler.
 * @param {string} cronExpression
 * @returns {boolean}
 */
function validate(cronExpression) {
    try {
        parseCronExpression(cronExpression);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    make,
    validate,
    parseCronExpression,
    isInvalidCronExpressionError,
    ScheduleDuplicateTaskError,
    isScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
    isScheduleInvalidNameError,
};

