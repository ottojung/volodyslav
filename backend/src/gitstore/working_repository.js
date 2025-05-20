//
// This modules provides definitions and methods
// for working with the local copy of the git repository
// that Volodyslav uses to store events in.
//

const environment = require("../environment");
const path = require("path");
const gitmethod = require("./wrappers");

/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */

/**
 * @typedef {object} Capabilities
 * @property {Command} git - A command instance for Git operations.
 * @property {FileCreator} creator - A file creator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {FileChecker} checker - A file checker instance.
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
        this.repositoryPath = repositoryPath;
    }
}

/**
 * Type guard for WorkingRepositoryError.
 * @param {unknown} object
 * @returns {object is WorkingRepositoryError}
 */
function isWorkingRepositoryError(object) {
    return object instanceof WorkingRepositoryError;
}

/**
 * Get local repository path.
 * @returns {string}
 */
function pathToLocalRepository() {
    const wd = environment.workingDirectory();
    return path.join(wd, "working-git-repository");
}

/** 
 * Get the path to the local repository's .git directory.
 * @returns {string}
 */
function pathToLocalRepositoryGitDir() {
    return path.join(pathToLocalRepository(), ".git");
}

/**
 * Synchronize the local repository with remote: pull if exists, else clone.
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 * @throws {WorkingRepositoryError}
 */
async function synchronize(capabilities) {
    const gitDir = pathToLocalRepositoryGitDir();
    const workDir = pathToLocalRepository();
    const indexFile = path.join(gitDir, "index");
    const remoteRepo = environment.eventLogRepository();
    try {
        if (await capabilities.checker.fileExists(indexFile)) {
            await gitmethod.pull(capabilities, workDir);
        } else {
            // TODO: rollback if any of the following operations fail.
            await gitmethod.clone(capabilities, remoteRepo, workDir);
            await gitmethod.makePushable(capabilities, workDir);
        }
    } catch (err) {
        throw new WorkingRepositoryError(
            `Failed to synchronize repository: ${err}`,
            remoteRepo
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
    const gitDir = pathToLocalRepositoryGitDir();
    const indexFile = path.join(gitDir, "index");

    if (!(await capabilities.checker.fileExists(indexFile))) {
        await synchronize(capabilities);
    }

    return gitDir;
}

module.exports = {
    synchronize,
    getRepository,
    isWorkingRepositoryError,
};
