const eventLogStorage = require("../event_log_storage");
const { processDiaryAudios } = require("../diary");
const { executeDailyTasks } = require("./daily");
const { fromObject: Duration } = require("../datetime");
const { synchronizeDatabase } = require("../generators");

/** @typedef {import('../scheduler').Registration} Registration */

/**
 * @typedef {import('../capabilities/root').Capabilities} Capabilities
 */

/**
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function everyHour(capabilities) {
    capabilities.logger.logInfo({}, "Running every hour tasks");

    await processDiaryAudios(capabilities).catch((error) => {
        capabilities.logger.logError({ error }, "Error in processDiaryAudios");
    });

    await eventLogStorage.synchronize(capabilities).catch((error) => {
        capabilities.logger.logError(
            { error },
            "Error during event log repository synchronization"
        );
    });

    await capabilities.interface.withDatabaseLocked(() =>
        synchronizeDatabase(capabilities)
    ).catch((error) => {
        capabilities.logger.logError(
            { error },
            "Error during generators database synchronization"
        );
    });

    await capabilities.interface.update().catch((error) => {
        capabilities.logger.logError(
            { error },
            "Error invalidating interface after synchronization"
        );
    });
}

/**
 * Daily tasks that run at 2AM.
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function daily(capabilities) {
    capabilities.logger.logInfo({}, "Running daily tasks");

    await executeDailyTasks(capabilities).catch((error) => {
        capabilities.logger.logError({ error }, "Error in daily tasks");
    });
}

/**
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function allTasks(capabilities) {
    await everyHour(capabilities).catch((error) =>
        capabilities.logger.logDebug({ error }, "Error in all tasks")
    );
}

/**
 * Schedules all tasks using the new declarative scheduler.
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function scheduleAll(capabilities) {
    // Use a reasonable retry delay for scheduled tasks - 5 minutes
    const retryDelay = Duration({minutes: 5});

    // Define all task registrations
    /** @type {Registration[]} */
    const registrations = [
        ["every-hour", "0 * * * *", () => everyHour(capabilities), retryDelay],
        ["daily-2am", "0 2 * * *", () => daily(capabilities), retryDelay],
    ];

    // Initialize the scheduler with all registrations
    await capabilities.scheduler.initialize(registrations);
}

/**
 * @param {Capabilities} capabilities
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
    everyHour,
    daily,
    allTasks,
    scheduleAll,
    runAllTasks,
};
