
const runtime_identifier = require("./runtime_identifier");

/**
 * @typedef Creator
 * @type {Object}
 * @property {string} name - The name of the creator.
 * @property {string} version - The version of the creator.
 */

/**
 * @returns {Promise<Creator>} - The creator object.
 */
async function creator() {
    const version = await runtime_identifier.version();
    return {
        name: "Volodyslav",
        version: version,
    };
}

module.exports = creator;
