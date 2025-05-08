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
 * @param {string[]} files - Array of file paths to add
 * @returns {Promise<void>}
 */
async function add(directory, files) {
    await GitCommand.call("-C", directory, "add", "--", ...files);
}

/**
 * Commit staged changes with a message
 * @param {string} directory - The git repository directory
 * @param {string} message - The commit message
 * @returns {Promise<void>}
 */
async function commit(directory, message) {
    await GitCommand.call("-C", directory, "commit", "-m", message);
}

/**
 * Show the current git status
 * @param {string} directory - The git repository directory
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function status(directory) {
    return GitCommand.call("-C", directory, "status");
}

/**
 * Show commit log
 * @param {string} directory - The git repository directory
 * @param {string[]} [options=[]] - Additional options for git log
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function log(directory, options = []) {
    return GitCommand.call("-C", directory, "log", ...options);
}

/**
 * Get the contents of a file at a specific commit
 * @param {string} directory - The git repository directory
 * @param {string} commitHash - The commit hash
 * @param {string} filePath - Path to the file
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function show(directory, commitHash, filePath) {
    return GitCommand.call("-C", directory, "show", `${commitHash}:${filePath}`);
}

/**
 * List all files in the repository at a specific commit
 * @param {string} directory - The git repository directory
 * @param {string} [commitHash="HEAD"] - The commit hash, defaults to HEAD
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function listFiles(directory, commitHash = "HEAD") {
    return GitCommand.call("-C", directory, "ls-tree", "-r", "--name-only", commitHash);
}

module.exports = {
    ensureGitAvailable,
    init,
    add,
    commit,
    status,
    log,
    show,
    listFiles,
};
