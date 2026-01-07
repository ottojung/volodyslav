/**
 * Generates a random identifier for the runtime.
 * Every new instance of Volodyslav will have a different identifier.
 * This is useful for tracking and debugging purposes.
 */

/** @typedef {import("./logger").Logger} Logger */

const random = require("./random");
const path = require('path');

/**
 * @typedef {object} Capabilities
 * @property {import("./random/seed").NonDeterministicSeed} seed
 * @property {import("./subprocess/command").Command} git
 * @property {Logger} logger - A logger instance.
 * @property {import("./filesystem/reader").FileReader} reader - A file reader instance.
 * @property {import("./filesystem/checker").FileChecker} checker - A file checker instance.
 */

/**
 * @param {Capabilities} capabilities
 * @returns {Promise<string>}
 */
async function getVersion(capabilities) {
    // First, try to read version from VERSION file (for installed versions)
    const versionFilePath = path.join(__dirname, '..', '..', 'VERSION');
    try {
        // Check if VERSION file exists and read it using capabilities
        const versionFile = await capabilities.checker.instantiate(versionFilePath);
        const version = await capabilities.reader.readFileAsText(versionFile.path);
        return version.trim();
    } catch {
        // VERSION file doesn't exist, try git
    }

    // Fall back to git describe (for development versions)
    await capabilities.git.ensureAvailable();
    try {
        const repositoryPath = __dirname;
        const { stdout } = await capabilities.git.call(
            "-C",
            repositoryPath,
            "describe"
        );
        return stdout.trim();
    } catch (error) {
        // If git is not available, we can assume that the version is unknown.
        const message =
            error instanceof Object && error !== null && "message" in error
                ? String(error.message)
                : String(error);
        capabilities.logger.logError({ error }, `Could not determine version: ${message}`);
        return "unknown";
    }
}

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
