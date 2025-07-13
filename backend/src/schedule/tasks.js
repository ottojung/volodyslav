const workingRepository = require("../gitstore/working_repository");
const { processDiaryAudios } = require("../diary");
const { executeDailyTasks } = require("./daily_tasks");

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
/** @typedef {import('../schedule').Scheduler} Scheduler */
/** @typedef {import('../logger').Logger} Logger */

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

    await workingRepository.synchronize(capabilities, "working-git-repository", capabilities.environment.eventLogRepository()).catch((error) => {
        capabilities.logger.logError(
            { error },
            "Error during workingRepository synchronization"
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
 * Schedules all tasks.
 * @param {Capabilities} capabilities
 */
function scheduleAll(capabilities) {
    capabilities.scheduler.schedule("0 * * * *", () => everyHour(capabilities));
    capabilities.scheduler.schedule("0 2 * * *", () => daily(capabilities));
}

module.exports = {
    everyHour,
    daily,
    allTasks,
    scheduleAll,
};
