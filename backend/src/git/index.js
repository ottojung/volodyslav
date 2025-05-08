const { CommandUnavailable } = require("../subprocess/command_unavailable");
const { registerCommand } = require("../subprocess");

class GitUnavailable extends CommandUnavailable {
    constructor() {
        super(
            "Git operations unavailable. Git executable not found in $PATH. Please ensure that Git is installed and available in your $PATH."
        );
    }
}

/**
 * @typedef {import('../subprocess/command').Command} Command
 */
const GitCommand = registerCommand("git");

/**
 * Ensures that the git executable exists in the PATH.
 * @returns {Promise<void>}
 */
async function ensureGitAvailable() {
    try {
        await GitCommand.ensureAvailable();
    } catch (error) {
        if (error instanceof CommandUnavailable) {
            throw new GitUnavailable();
        }
        throw error;
    }
}

/**
 * Initialize a git repository in the specified directory
 * @param {string} directory - The directory to initialize the git repository in
 * @returns {Promise<void>}
 */
async function init(directory) {
    await GitCommand.call("-C", directory, "init");
}

/**
 * Add files to git staging area
 * @param {string} directory - The git repository directory
 * @returns {Promise<void>}
 */
async function addAll(directory) {
    await GitCommand.call("-C", directory, "add", "--all");
}

/**
 * Commit staged changes with a message
 * @param {string} directory - The git repository directory
 * @param {string} message - The commit message
 * @returns {Promise<void>}
 */
async function commit(directory, message) {
    await GitCommand.call(
        "-C",
        directory,
        "--config",
        `safe.directory=${directory}`,
        "commit",
        "-m",
        message
    );
}

module.exports = {
    ensureGitAvailable,
    init,
    addAll,
    commit,
};
