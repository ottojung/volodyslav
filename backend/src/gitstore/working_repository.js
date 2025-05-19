//
// This modules provides definitions and methods 
// for working with the local copy of the git repository
// that Volodyslav uses to store events in.
//

const environment = require("../environment");
const path = require("path");
const fs = require("fs").promises;
const { ensureGitAvailable, clone } = require("./wrappers");
const defaultBranch = require("./default_branch");

/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */

/**
 * @typedef {object} Capabilities
 * @property {Command} git - A command instance for Git operations.
 * @property {FileCreator} creator - A file creator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
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
 * Synchronize the local repository with remote: pull if exists, else clone.
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 * @throws {WorkingRepositoryError}
 */
async function synchronize(capabilities) {
    const localRepoPath = pathToLocalRepository();
    const remoteRepo = environment.eventLogRepository();
    try {
        await ensureGitAvailable();
        await fs.access(localRepoPath);
        // Pull latest changes
        await capabilities.git.call(
            "-C", localRepoPath,
            "-c", "safe.directory=*",
            "-c", "user.name=volodyslav",
            "-c", "user.email=volodyslav",
            "pull",
            "origin",
            defaultBranch
        );
    } catch (err) {
        const anyErr = /** @type {{code?:string, message?:string}} */ (err);
        if (anyErr.code === "ENOENT") {
            try {
                // Clone repository if not present
                await clone(capabilities, remoteRepo, localRepoPath);
            } catch (cloneErr) {
                throw new WorkingRepositoryError(
                    `Failed to clone repository: ${remoteRepo}`,
                    localRepoPath
                );
            }
        } else {
            throw new WorkingRepositoryError(
                `Failed to synchronize repository: ${anyErr.message || anyErr}`,
                localRepoPath
            );
        }
    }
}

/**
 * Ensure the repository is present locally and return its path.
 * @param {Capabilities} capabilities
 * @returns {Promise<string>}
 * @throws {WorkingRepositoryError}
 */
async function getRepository(capabilities) {
    const localRepoPath = pathToLocalRepository();
    try {
        await synchronize(capabilities);
        await fs.access(localRepoPath);
        return localRepoPath;
    } catch (err) {
        const anyErr = /** @type {{code?:string}} */ (err);
        if (isWorkingRepositoryError(err) || anyErr.code === "ENOENT") {
            throw new WorkingRepositoryError(
                `Repository unavailable at: ${localRepoPath}`,
                localRepoPath
            );
        }
        throw err;
    }
}

module.exports = {
    synchronize,
    getRepository,
    isWorkingRepositoryError,
};
