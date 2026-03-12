
const runtime_identifier = require("./runtime_identifier");

/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('./subprocess/command').Command} Command */
/** @typedef {import('./logger').Logger} Logger */
/** @typedef {import('./environment').Environment} Environment */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {Logger} logger - A logger instance.
 * @property {Command} git - A command instance for Git operations.
 * @property {import('./filesystem/reader').FileReader} reader - A file reader instance.
 * @property {import('./filesystem/checker').FileChecker} checker - A file checker instance.
 * @property {Environment} environment - An environment instance.
 */

/**
 * @typedef Creator
 * @type {Object}
 * @property {string} name - The name of the creator.
 * @property {string} uuid - The UUID of the creator.
 * @property {string} version - The version of the creator.
 * @property {string} hostname - The hostname of the machine that created this entry.
 */

/**
 * Creates a new creator object.
 * @param {Capabilities} capabilities - The capabilities object.
 * @returns {Promise<Creator>} - The creator object.
 */
async function creator(capabilities) {
    const { version } = await runtime_identifier(capabilities);
    return {
        name: "Volodyslav",
        uuid: '81c3188c-d2cc-4879-a237-cdd0f1121346',
        version: version,
        hostname: capabilities.environment.hostname(),
    };
}

module.exports = creator;
