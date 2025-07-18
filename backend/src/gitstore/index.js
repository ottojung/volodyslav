const { commit, push, clone } = require("./wrappers");
const path = require("path");
const workingRepository = require("./working_repository");

/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */

/**
 * @typedef {object} RemoteLocation
 * @property {string} url - The URL or path to the remote repository
 */

/**
 * @typedef {object} Capabilities
 * @property {Command} git - A command instance for Git operations.
 * @property {FileCreator} creator - A file creator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 */

/**
 * Creates a temporary work tree for Git operations.
 * @param {Capabilities} capabilities - The capabilities object.
 * @returns {Promise<string>} - A promise that resolves to the path of the temporary work tree.
 */
async function makeTemporaryWorkTree(capabilities) {
    return capabilities.creator.createTemporaryDirectory(capabilities);
}

class GitStoreClass {
    /**
     * @param {string} workTree
     * @param {Capabilities} capabilities
     * @constructor
     */
    constructor(workTree, capabilities) {
        this.workTree = workTree;
        this.capabilities = capabilities;
    }

    /**
     * @returns {Promise<string>}
     */
    async getWorkTree() {
        return this.workTree;
    }

    /**
     * @param {string} message
     * @returns {Promise<void>}
     */
    async commit(message) {
        const workTree = await this.getWorkTree();
        const gitDir = path.join(workTree, ".git");
        await commit(this.capabilities, gitDir, workTree, message); // Use wrapper
    }
}

/**
 * @typedef {GitStoreClass} GitStore
 */

/**
 * This function performs a transaction on a Git repository.
 *
 * It gives you a temporary work tree, reset to the last commit,
 * and allows you to perform a transformation on it.
 *
 * It is atomic: if the transformation fails, the changes are not committed.
 * Caveat: if you are calling commit() multiple times, they won't necessarily be consequtive.
 *
 * @template T
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {string} workingPath - Path to the working directory (local repository)
 * @param {RemoteLocation | "empty"} initial_state - Remote location to sync with, or "empty" for local-only
 * @param {function(GitStore): Promise<T>} transformation - A function that takes a directory path and performs some operations on it
 * @returns {Promise<T>}
 */
async function transaction(capabilities, workingPath, initial_state, transformation) {
    // TODO: retry several times if the repository is busy.
    const workTree = await makeTemporaryWorkTree(capabilities);
    try {
        const git_directory = await workingRepository.getRepository(capabilities, workingPath, initial_state);
        const store = new GitStoreClass(workTree, capabilities);
        await clone(capabilities, git_directory, workTree);
        const result = await transformation(store);
        await push(capabilities, workTree);
        return result;
    } finally {
        await capabilities.deleter.deleteDirectory(workTree);    
    }
}

module.exports = {
    transaction,
};
