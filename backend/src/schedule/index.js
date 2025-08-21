const { allTasks } = require("./tasks");
const cronScheduler = require("../cron");
const memconst = require("../memconst");

/** @typedef {ReturnType<make>} Scheduler */

/**
 * @param {() => import("./tasks").Capabilities} getCapabilities
 */
function make(getCapabilities) {
    // Create a polling scheduler instance
    const getPollingScheduler = memconst(() => cronScheduler.make(getCapabilities()));

    return {
        /**
         * @param {string} name
         * @param {string} cronExpression
         * @param {() => Promise<void>} callback
         * @param {import('../time_duration/structure').TimeDuration} retryDelay
         * @returns {Promise<string>}
         */
        schedule: async (name, cronExpression, callback, retryDelay) => {
            await getPollingScheduler().schedule(name, cronExpression, callback, retryDelay);
            return name;
        },
        
        /**
         * Cancel a task by name.
         * @param {string} name
         * @returns {Promise<boolean>}
         */
        cancel: async (name) => {
            return await getPollingScheduler().cancel(name);
        },
        
        /**
         * Cancel all tasks.
         * @returns {Promise<number>}
         */
        cancelAll: async () => {
            return await getPollingScheduler().cancelAll();
        },
        
        /**
         * Get task information.
         * @returns {Promise<Array<{name:string,cronExpression:string,running:boolean,lastSuccessTime?:string,lastFailureTime?:string,lastAttemptTime?:string,pendingRetryUntil?:string,modeHint:"retry"|"cron"|"idle"}>>}
         */
        getTasks: async () => {
            return await getPollingScheduler().getTasks();
        },
        
        /**
         * Validate a cron expression.
         * @param {string} cronExpression
         * @returns {boolean}
         */
        validate: (cronExpression) => {
            return getPollingScheduler().validate(cronExpression);
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

