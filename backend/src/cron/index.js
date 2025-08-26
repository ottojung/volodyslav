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
 * @typedef {import('./scheduling/types').Registration} Registration
 * @typedef {import('./scheduling/types').Callback} Callback
 * @typedef {import('./scheduling/types').ParsedRegistrations} ParsedRegistrations
 */

/**
 * Creates a new polling scheduler instance.
 * @param {import('../capabilities/root').Capabilities} capabilities
 * @param {ParsedRegistrations} registrations
 */
function make(capabilities, registrations) {
    const scheduler = makePollingScheduler(capabilities, registrations);
    return {
        /**
         * Schedule a task.
         * @param {string} name
         * @param {string} cronExpression
         * @param {Callback} callback
         * @param {import('../time_duration/structure').TimeDuration} retryDelay
         * @returns {Promise<void>}
         */
        async schedule(name, cronExpression, callback, retryDelay) {
            await scheduler.schedule(name, cronExpression, callback, retryDelay);
        },

        /**
         * Cancel a task by name.
         * @param {string} name
         * @returns {Promise<boolean>}
         */
        async cancel(name) {
            return await scheduler.cancel(name);
        },
        /**
         * Cancel all tasks and stop polling.
         * @returns {Promise<number>}
         */
        async cancelAll() {
            return await scheduler.cancelAll();
        },

        /**
         * Stop the main loop.
         * @returns {Promise<void>}
         */
        async stop() {
            return await scheduler.stopLoop();
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

