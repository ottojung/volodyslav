const { CommandUnavailable } = require("../subprocess");
const { git } = require("../executables");

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
 * @param {string} git_directory - The `.git` directory
 * @param {string} work_directory - The repository directory, where the actual files are
 * @param {string} message - The commit message
 * @returns {Promise<void>}
 */
async function commit(git_directory, work_directory, message) {
    await git.call(
        "--git-dir", git_directory,
        "--work-tree", work_directory,
        "--config", "safe.directory=*",
        "commit",
        "--all",
        "--message", message
    );
}

module.exports = {
    ensureGitAvailable,
    commit,
};
