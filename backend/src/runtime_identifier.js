/**
 * Generates a random identifier for the runtime.
 * Every new instance of Volodyslav will have a different identifier.
 * This is useful for tracking and debugging purposes.
 */

const { git } = require("./executables");
const { logError } = require("./logger");
const memconst = require("./memconst");
const random = require("./random");
const rootCapabilities = require("./capabilities/root");

let version = memconst(async () => {
    git.ensureAvailable();
    try {
        const repositoryPath = __dirname;
        const { stdout } = await git.call("-C", repositoryPath, "describe");
        return stdout.trim();
    } catch (error) {
        // If git is not available, we can assume that the version is unknown.
        const message = error instanceof Error ? error.message : String(error);
        logError({ error }, `Could not determine version: ${message}`);
        return "unknown";
    }
});

/**
 * @typedef {object} Capabilities
 * @property {import("./random/seed").NonDeterministicSeed} seed
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
 * @returns {Promise<{ version: string, instanceIdentifier: string }>}
 */
async function getRuntimeIdentifier() {
    const capabilities = rootCapabilities.make();
    const instanceIdentifier = generateRandomIdentifier(capabilities);
    return { version: await version(), instanceIdentifier };
}

const runtimeIdentifier = memconst(async () => getRuntimeIdentifier());

module.exports = runtimeIdentifier;
