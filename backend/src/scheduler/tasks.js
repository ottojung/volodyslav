const eventLogStorage = require("../event_log_storage");
const { processDiaryAudios } = require("../diary");
const { executeDailyTasks } = require("./daily_tasks");
const { COMMON } = require("../time_duration");
const { initialize } = require("./index");

/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('../filesystem/copier').FileCopier} FileCopier */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../filesystem/appender').FileAppender} FileAppender */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('./types').Registration} Registration */
/** @typedef {import('../capabilities/root').Capabilities} Capabilities */

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
}

/**
 * Daily tasks that run at 2AM.
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function daily(capabilities) {
    capabilities.logger.logInfo({}, "Running daily tasks");

    await executeDailyTasks(capabilities).catch(/** @param {any} error */ (error) => {
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
    const { fromMs } = require('./value-objects/time-duration');
    
    // Convert project TimeDuration to scheduler TimeDuration
    const retryDelay = fromMs(COMMON.FIVE_MINUTES.toMilliseconds());

    // Define all task registrations
    /** @type {Registration[]} */
    const registrations = [
        ["every-hour", "0 * * * *", () => everyHour(capabilities), retryDelay],
        ["daily-2am", "0 2 * * *", () => daily(capabilities), retryDelay],
    ];

    // Initialize the scheduler with the registrations
    await initialize(capabilities, registrations);
}

module.exports = {
    everyHour,
    daily,
    allTasks,
    scheduleAll,
};