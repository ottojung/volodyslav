const workingRepository = require("../gitstore/working_repository");

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
 */

/**
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function everyHour(capabilities) {
    // await processDiaryAudios(capabilities);
    await workingRepository.synchronize(capabilities);
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
    scheduleAll,
};
