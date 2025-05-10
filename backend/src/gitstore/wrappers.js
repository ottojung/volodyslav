const { CommandUnavailable } = require("../subprocess");
const { git } = require("../executables");
const defaultBranch = require("./default_branch");

class GitUnavailable extends CommandUnavailable {
    constructor() {
        super(
            "Git operations unavailable. Git executable not found in $PATH. Please ensure that Git is installed and available in your $PATH."
        );
    }
}

/**
 * Ensures that the git executable exists in the PATH.
 * @returns {Promise<void>}
 */
async function ensureGitAvailable() {
    try {
        await git.ensureAvailable();
    } catch (error) {
        if (error instanceof CommandUnavailable) {
            throw new GitUnavailable();
        }
        throw error;
    }
}

/**
 * Commit staged changes with a message
 * Note: this operation is atomic. Details at <https://chatgpt.com/share/681d3dcb-a948-800e-8aca-896c8ba2aa07>.
 * @param {string} git_directory - The `.git` directory
 * @param {string} work_directory - The repository directory, where the actual files are
 * @param {string} message - The commit message
 * @returns {Promise<void>}
 */
async function commit(git_directory, work_directory, message) {
    await git.call(
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
        "--all",
        "--message",
        message
    );
}

/**
 * Reset the working directory to the last commit.
 * @param {string} git_directory - The `.git` directory
 * @param {string} work_directory - The repository directory, where the actual files are
 * @returns {Promise<void>}
 */
async function reset(git_directory, work_directory) {
    await git.call(
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
        "reset",
        "--hard"
    );
}

/**
 * Clone latest changes from the remote repository.
 * @param {string} remote_uri - The repository path to pull from (can be a remote URI or local path)
 * @param {string} work_directory - The repository directory to pull to
 * @returns {Promise<void>}
 */
async function clone(remote_uri, work_directory) {
    await git.call(
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
 * Push changes to the remote repository.
 * @param {string} work_directory - The repository directory to push from
 * @returns {Promise<void>}
 */
async function push(work_directory) {
    await git.call(
        "-C",
        work_directory,
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
}

module.exports = {
    ensureGitAvailable,
    commit,
    reset,
    clone,
    push,
    GitUnavailable,
};
