const { allTasks } = require("./tasks");
const cronScheduler = require("../cron");

/** @typedef {ReturnType<make>} Scheduler */

/**
 * @param {import("./tasks").Capabilities} capabilities
 */
function make(capabilities) {
    // Create a polling scheduler instance
    const pollingScheduler = cronScheduler.make(capabilities);
    
    return {
        /**
         * @param {string} name
         * @param {string} cronExpression
         * @param {() => Promise<void>} callback
         * @param {import('../time_duration/structure').TimeDuration} retryDelay
         * @returns {Promise<string>}
         */
        schedule: async (name, cronExpression, callback, retryDelay) => {
            await pollingScheduler.schedule(name, cronExpression, callback, retryDelay);
            return name;
        },
        
        /**
         * Cancel a task by name.
         * @param {string} name
         * @returns {Promise<boolean>}
         */
        cancel: async (name) => {
            return await pollingScheduler.cancel(name);
        },
        
        /**
         * Cancel all tasks.
         * @returns {Promise<number>}
         */
        cancelAll: async () => {
            return await pollingScheduler.cancelAll();
        },
        
        /**
         * Get task information.
         * @returns {Promise<Array<{name:string,cronExpression:string,running:boolean,lastSuccessTime?:string,lastFailureTime?:string,lastAttemptTime?:string,pendingRetryUntil?:string,modeHint:"retry"|"cron"|"idle"}>>}
         */
        getTasks: async () => {
            return await pollingScheduler.getTasks();
        },
        
        /**
         * Validate a cron expression.
         * @param {string} cronExpression
         * @returns {boolean}
         */
        validate: (cronExpression) => {
            return pollingScheduler.validate(cronExpression);
        },
    };
}

/**
 * @param {import("./tasks").Capabilities} capabilities
 */
function runAllTasks(capabilities) {
    return async () => {
        await capabilities.logger.setup();
        capabilities.logger.logInfo({}, "Running all periodic tasks now");
        await allTasks(capabilities);
        capabilities.logger.logInfo({}, "All periodic tasks have been run.");
    };
}

module.exports = {
    make,
    runAllTasks,
};

