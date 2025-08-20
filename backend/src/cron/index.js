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
 * @param {{pollIntervalMs?: number, exposeInternalForTesting?: boolean}} [options]
 */
function make(capabilities, options = {}) {
    const scheduler = makePollingScheduler(capabilities, options);
    const publicAPI = {
        /**
         * Schedule a task.
         * @param {string} name
         * @param {string} cronExpression
         * @param {() => Promise<void> | void} callback
         * @param {import('../time_duration/structure').TimeDuration} retryDelay
         * @returns {Promise<string>}
         */
        async schedule(name, cronExpression, callback, retryDelay) {
            return await scheduler.schedule(name, cronExpression, callback, retryDelay);
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
         * Get info about tasks.
         * @returns {Promise<Array<{name:string,cronExpression:string,running:boolean,lastSuccessTime?:string,lastFailureTime?:string,lastAttemptTime?:string,pendingRetryUntil?:string,modeHint:"retry"|"cron"|"idle"}>>}
         */
        async getTasks() {
            return await scheduler.getTasks();
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
    
    // Expose internal scheduler for testing if requested
    if (options.exposeInternalForTesting) {
        // @ts-expect-error - Adding internal scheduler for testing
        publicAPI._internal = scheduler;
    }
    
    return publicAPI;
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

