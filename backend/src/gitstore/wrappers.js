const { isCommandUnavailable } = require("../subprocess");
const { git } = require("../executables");
const defaultBranch = require("./default_branch");

/** @typedef {import('../subprocess/command').Command} Command */

/**
 * @typedef {object} Capabilities
 * @property {Command} git - A command instance for Git operations.
 */

class GitUnavailable extends Error {
    constructor() {
        super(
            "Git operations unavailable. Git executable not found in $PATH. Please ensure that Git is installed and available in your $PATH."
        );
    }
}

/**
 * Error thrown when git push operation fails.
 */
class PushError extends Error {
    /**
     * @param {string} message - Error message
     * @param {string} workDirectory - The directory where push failed
     * @param {Error|null} cause - Underlying cause of the error
     */
    constructor(message, workDirectory, cause = null) {
        super(message);
        this.name = "PushError";
        this.workDirectory = workDirectory;
        this.cause = cause;
    }
}

/**
 * Type guard for PushError.
 * @param {unknown} object - The object to check.
 * @returns {object is PushError}
 */
function isPushError(object) {
    return object instanceof PushError;
}

/**
 * Ensures that the git executable exists in the PATH.
 * @returns {Promise<void>}
 */
async function ensureGitAvailable() {
    try {
        await git.ensureAvailable();
    } catch (error) {
        if (isCommandUnavailable(error)) {
            throw new GitUnavailable();
        }
        throw error;
    }
}

/**
 * Commit staged changes with a message
 * @param {Capabilities} capabilities - The capabilities object containing the git command.
 * @param {string} git_directory - The `.git` directory
 * @param {string} work_directory - The repository directory, where the actual files are
 * @param {string} message - The commit message
 * @returns {Promise<void>}
 */
async function commit(capabilities, git_directory, work_directory, message) {
    // First add all files (including new untracked files) to the staging area
    await capabilities.git.call(
        "-c",
        "safe.directory=*",
        "-c",
        "user.name=volodyslav",
        "-c",
        "user.email=volodyslav",
        "--git-dir",
        git_directory,
        "--work-tree",
        work_directory,
        "add",
        "--all"
    );

    // Then commit all staged changes
    await capabilities.git.call(
        "-c",
        "safe.directory=*",
        "-c",
        "user.name=volodyslav",
        "-c",
        "user.email=volodyslav",
        "--git-dir",
        git_directory,
        "--work-tree",
        work_directory,
        "commit",
        "--message",
        message
    );
}

/**
 * Make the repository pushable by setting up the necessary configuration.
 * @param {Capabilities} capabilities - The capabilities object containing the git command.
 * @param {string} workDirectory - The repository directory to make pushable
 * @returns {Promise<void>}
 */
async function makePushable(capabilities, workDirectory) {
    // Make sure that we can push to this repository
    // as if it was a bare repository.
    await capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "-c",
        "user.name=volodyslav",
        "-c",
        "user.email=volodyslav",
        "config",
        "receive.denyCurrentBranch",
        "ignore"
    );
}

/**
 * Clone latest changes from the remote repository.
 * @param {Capabilities} capabilities - The capabilities object containing the git command.
 * @param {string} remote_uri - The repository path to pull from (can be a remote URI or local path)
 * @param {string} work_directory - The repository directory to pull to
 * @returns {Promise<void>}
 */
async function clone(capabilities, remote_uri, work_directory) {
    await capabilities.git.call(
        "-c",
        "safe.directory=*",
        "-c",
        "user.name=volodyslav",
        "-c",
        "user.email=volodyslav",
        "clone",
        "--depth=1",
        "--single-branch",
        `--branch=${defaultBranch}`,
        "--",
        remote_uri,
        work_directory
    );
}

/** 
 * Pull changes from the remote repository.
 * @param {Capabilities} capabilities - The capabilities object containing the git command.
 * @param {string} workDirectory - The repository directory to pull from
 * @returns {Promise<void>}
 */
async function pull(capabilities, workDirectory) {
    await capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "-c",
        "user.name=volodyslav",
        "-c",
        "user.email=volodyslav",
        "pull",
        "origin",
        defaultBranch
    );
}

/**
 * Push changes to the remote repository.
 * @param {Capabilities} capabilities - The capabilities object containing the git command.
 * @param {string} workDirectory - The repository directory to push from
 * @returns {Promise<void>}
 * @throws {PushError} When push operation fails
 */
async function push(capabilities, workDirectory) {
    try {
        await capabilities.git.call(
            "-C",
            workDirectory,
            "-c",
            "safe.directory=*",
            "-c",
            "user.name=volodyslav",
            "-c",
            "user.email=volodyslav",
            "push",
            "origin",
            defaultBranch
        );
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new PushError(
            `Failed to push to remote repository: ${errorMessage}`,
            workDirectory,
            error instanceof Error ? error : null
        );
    }
}

/**
 * Initialize a new git repository.
 * @param {Capabilities} capabilities - The capabilities object containing the git command.
 * @param {string} workDirectory - The directory to initialize as a git repository
 * @returns {Promise<void>}
 */
async function init(capabilities, workDirectory) {
    await capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "-c",
        "user.name=volodyslav",
        "-c",
        "user.email=volodyslav",
        "init",
        "--template",
        "/proc/some/non/existant/path",
        "--initial-branch",
        defaultBranch
    );
}

module.exports = {
    ensureGitAvailable,
    commit,
    makePushable,
    clone,
    pull,
    push,
    init,
    PushError,
    isPushError,
};
