
const runtime_identifier = require("./runtime_identifier");

/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('./subprocess/command').Command} Command */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {Command} git - A command instance for Git operations.
 */

/**
 * @typedef Creator
 * @type {Object}
 * @property {string} name - The name of the creator.
 * @property {string} version - The version of the creator.
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
        version: version,
    };
}

module.exports = creator;
