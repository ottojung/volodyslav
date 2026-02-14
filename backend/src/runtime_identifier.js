/**
 * Generates a random identifier for the runtime.
 * Every new instance of Volodyslav will have a different identifier.
 * This is useful for tracking and debugging purposes.
 */

/** @typedef {import("./logger").Logger} Logger */

const random = require("./random");
const { getVersion } = require("./version");

/**
 * @typedef {object} Capabilities
 * @property {import("./random/seed").NonDeterministicSeed} seed
 * @property {import("./subprocess/command").Command} git
 * @property {Logger} logger - A logger instance.
 * @property {import("./filesystem/reader").FileReader} reader - A file reader instance.
 * @property {import("./filesystem/checker").FileChecker} checker - A file checker instance.
 */

/**
 * Generates a random identifier for the runtime.
 * @param {Capabilities} capabilities
 * @returns {string}
 */
function generateRandomIdentifier(capabilities) {
    return random.string(capabilities);
}

/**
 * Generates a runtime identifier.
 * @param {Capabilities} capabilities
 * @returns {Promise<{ version: string, instanceIdentifier: string }>}
 */
async function getRuntimeIdentifier(capabilities) {
    const instanceIdentifier = generateRandomIdentifier(capabilities);
    const version = await getVersion(capabilities);
    return { version, instanceIdentifier };
}

/**
 * @type {{ version: string, instanceIdentifier: string }}
 */
let runtimeIdentifierState;

/**
 * @param {Capabilities} capabilities
 * @returns {Promise<{ version: string, instanceIdentifier: string }>}
 */
async function runtimeIdentifier(capabilities) {
    if (runtimeIdentifierState === undefined) {
        runtimeIdentifierState = await getRuntimeIdentifier(capabilities);
    }

    return runtimeIdentifierState;
}

module.exports = runtimeIdentifier;
