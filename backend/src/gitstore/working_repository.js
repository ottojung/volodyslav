//
// This module provides definitions and methods
// for working with the local copy of the git repository
// that Volodyslav uses to store events in.
//

const path = require("path");
const gitmethod = require("./wrappers");

/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */

/**
 * @typedef {object} Capabilities
 * @property {Command} git - A command instance for Git operations.
 * @property {FileCreator} creator - A file creator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 */

/**
 * Custom error for WorkingRepository operations.
 */
class WorkingRepositoryError extends Error {
    /**
     * @param {string} message
     * @param {string} repositoryPath
     */
    constructor(message, repositoryPath) {
        super(message);
        this.name = "WorkingRepositoryError";
        this.repositoryPath = repositoryPath;
    }
}

/**
 * Type guard for WorkingRepositoryError.
 * @param {unknown} object - The object to check.
 * @returns {object is WorkingRepositoryError}
 */
function isWorkingRepositoryError(object) {
    return object instanceof WorkingRepositoryError;
}

/**
 * Get local repository path.
 * @param {Capabilities} capabilities - The capabilities object containing environment access.
 * @returns {string} - The absolute path to the local git repository.
 */
function pathToLocalRepository(capabilities) {
    const wd = capabilities.environment.workingDirectory();
    return path.join(wd, "working-git-repository");
}

/**
 * Get the path to the local repository's .git directory.
 * @param {Capabilities} capabilities - The capabilities object containing environment access.
 * @returns {string} - The absolute path to the .git directory.
 */
function pathToLocalRepositoryGitDir(capabilities) {
    return path.join(pathToLocalRepository(capabilities), ".git");
}

/**
 * Synchronize the local repository with remote: pull if exists, else clone.
 * Then push the changes as well.
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 * @throws {WorkingRepositoryError}
 */
async function synchronize(capabilities) {
    const gitDir = pathToLocalRepositoryGitDir(capabilities);
    const workDir = pathToLocalRepository(capabilities);
    const indexFile = path.join(gitDir, "index");
    const repository = capabilities.environment.eventLogRepository();
    try {
        capabilities.logger.logInfo({ repository }, "Synchronizing repository");
        if (await capabilities.checker.fileExists(indexFile)) {
            await gitmethod.pull(capabilities, workDir);
            await gitmethod.push(capabilities, workDir);
        } else {
            // TODO: rollback if any of the following operations fail.
            await gitmethod.clone(capabilities, repository, workDir);
            await gitmethod.makePushable(capabilities, workDir);
        }
    } catch (err) {
        throw new WorkingRepositoryError(
            `Failed to synchronize repository: ${err}`,
            repository
        );
    }
}

/**
 * Ensure the repository is present locally and return its path.
 * Note: returns the path to the `.git` directory.
 * @param {Capabilities} capabilities
 * @returns {Promise<string>}
 * @throws {WorkingRepositoryError}
 */
async function getRepository(capabilities) {
    const gitDir = pathToLocalRepositoryGitDir(capabilities);
    const indexFile = path.join(gitDir, "index");

    if (!(await capabilities.checker.fileExists(indexFile))) {
        await synchronize(capabilities);
    }

    return gitDir;
}

/**
 * Ensure the repository is present locally.
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function ensureAccessible(capabilities) {
    await getRepository(capabilities);
}

module.exports = {
    synchronize,
    getRepository,
    ensureAccessible,
    isWorkingRepositoryError,
};
