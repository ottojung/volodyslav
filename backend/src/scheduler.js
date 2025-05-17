// const cron = require('node-cron');
const { processDiaryAudios } = require("./diary");
const capabilities = require("./capabilities/root");

/** @typedef {import('./filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('./filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('./filesystem/copier').FileCopier} FileCopier */
/** @typedef {import('./filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('./filesystem/appender').FileAppender} FileAppender */
/** @typedef {import('./filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('./subprocess/command').Command} Command */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {DirScanner} scanner - A directory scanner instance.
 * @property {FileCopier} copier - A file copier instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {FileAppender} appender - A file appender instance.
 * @property {FileCreator} creator - A directory creator instance.
 * @property {Command} git - A command instance for Git operations.
 */

async function everyHour() {
    await processDiaryAudios(capabilities.make());
}

/**
 * @param {Capabilities} _capabilities
 * @description Sets up the scheduler to run tasks at specified intervals.
 */
async function setup(_capabilities) {
    // TODO: use the capabilities.
    // cron.schedule('0 * * * *', everyHour);
}

module.exports = {
    setup,
    everyHour,
};
