//
// This modules provides definitions and methods 
// for working with the local copy of the git repository
// that Volodyslav uses to store events in.
//

const environment = require("../environment");
const path = require("path");
const fs = require("fs").promises;
const { git } = require("../executables");
const { ensureGitAvailable } = require("./wrappers");
const defaultBranch = require("./default_branch");

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
 * @returns {Promise<void>}
 * @throws {WorkingRepositoryError}
 */
async function synchronize() {
    const localRepoPath = pathToLocalRepository();
    const remoteRepo = environment.eventLogRepository();
    try {
        await ensureGitAvailable();
        await fs.access(localRepoPath);
        await git.call(
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
                await git.call(
                    "-c", "safe.directory=*",
                    "-c", "user.name=volodyslav",
                    "-c", "user.email=volodyslav",
                    "clone",
                    "--depth=1",
                    "--single-branch",
                    `--branch=${defaultBranch}`,
                    "--",
                    remoteRepo,
                    localRepoPath
                );
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
 * @returns {Promise<string>}
 * @throws {WorkingRepositoryError}
 */
async function getRepository() {
    const localRepoPath = pathToLocalRepository();
    try {
        await synchronize();
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
