const { allTasks } = require("./tasks");
const { schedule } = require("./runner");

/** @typedef {ReturnType<make>} Scheduler */

/**
 * @param {import("./tasks").Capabilities} capabilities
 */
function make(capabilities) {
    return {
        /**
         * @param {string} cronExpression
         * @param {() => Promise<void>} callback
         * @param {import('../time_duration/structure').TimeDuration} retryDelay
         * @returns {string}
         */
        schedule: (cronExpression, callback, retryDelay) => schedule(capabilities, cronExpression, callback, retryDelay),
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
