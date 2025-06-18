const workingRepository = require("../gitstore/working_repository");
const { processDiaryAudios } = require("../diary");

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
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {DirScanner} scanner - A directory scanner instance.
 * @property {FileCopier} copier - A file copier instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {FileAppender} appender - A file appender instance.
 * @property {FileCreator} creator - A directory creator instance.
 * @property {FileChecker} checker - A file system checker instance.
 * @property {Command} git - A command instance for Git operations.
 * @property {Environment} environment - An environment instance.
 * @property {Scheduler} scheduler - A scheduler instance.
 * @property {Logger} logger - A logger instance.
 * @property {import('../filesystem/reader').FileReader} reader - A file reader instance.
 * @property {import('../datetime').Datetime} datetime - Datetime utilities.
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

    await workingRepository.synchronize(capabilities).catch((error) => {
        capabilities.logger.logError(
            { error },
            "Error during workingRepository synchronization"
        );
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
}

module.exports = {
    everyHour,
    allTasks,
    scheduleAll,
};
