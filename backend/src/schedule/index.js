const { allTasks } = require("./tasks");
const { schedule } = require("./runner");

/** @typedef {ReturnType<make>} Scheduler */

function make() {
    return {
        schedule,
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
