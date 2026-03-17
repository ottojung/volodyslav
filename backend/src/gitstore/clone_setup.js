const gitmethod = require("./wrappers");
const { configureRemoteForAllBranches } = require("./branch_setup");
const filesystem = require("../filesystem");

/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../filesystem/mover').FileMover} FileMover */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */

/**
 * @typedef {object} Capabilities
 * @property {Command} git - A command instance for Git operations.
 * @property {FileCreator} creator - A file creator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {FileMover} mover - A file mover instance.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 */

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isDestinationCollisionError(error) {
    if (filesystem.mover.isDestinationExistsError(error)) {
        return true;
    }
    return (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "EEXIST" || error.code === "ENOTEMPTY")
    );
}

/**
 * Clone into a temporary directory, run post-clone setup there, and only then
 * move it into the final location atomically.
 *
 * This ensures partial setup failures clean up only the temp directory owned
 * by this attempt. For destination collisions (from concurrent setup), this
 * treats the operation as successful only when `.git/HEAD` already exists at
 * the destination; otherwise the caller retries/fails.
 *
 * @param {Capabilities} capabilities
 * @param {{ remotePath: string, workDir: string, headFile: string }} options
 * @returns {Promise<void>}
 */
async function cloneAndConfigureRepository(capabilities, options) {
    const { remotePath, workDir, headFile } = options;
    const tempDir = await capabilities.creator.createTemporaryDirectory(capabilities);
    try {
        await gitmethod.clone(capabilities, remotePath, tempDir);
        await configureRemoteForAllBranches(capabilities, tempDir);
        await gitmethod.makePushable(capabilities, tempDir);
        await capabilities.mover.moveDirectory(tempDir, workDir);
    } catch (error) {
        await capabilities.deleter.deleteDirectory(tempDir).catch(cleanupError => {
            capabilities.logger.logInfo(
                { tempDir, cleanupError },
                "Failed to delete temporary clone directory during cleanup"
            );
        });
        if (isDestinationCollisionError(error)) {
            if (await capabilities.checker.fileExists(headFile)) {
                return;
            }
        }
        throw error;
    }
}

module.exports = {
    cloneAndConfigureRepository,
};
