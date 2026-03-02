
const path = require('path');

/**
 * @typedef {object} Capabilities
 * @property {import("./subprocess/command").Command} git
 * @property {import("./logger").Logger} logger - A logger instance.
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

module.exports = {
    getVersion,
};
