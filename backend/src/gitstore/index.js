const fs = require("fs").promises;
const { commit, push, clone } = require("./wrappers");
const path = require("path");

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
 * Creates a temporary work tree for Git operations.
 * @param {Capabilities} capabilities - The capabilities object.
 * @returns {Promise<string>} - A promise that resolves to the path of the temporary work tree.
 */
async function makeTemporaryWorkTree(capabilities) {
    return capabilities.creator.createTemporaryDirectory();
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
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {string} git_directory - The `.git` directory
 * @param {function(GitStore): Promise<void>} transformation - A function that takes a directory path and performs some operations on it
 * @returns {Promise<void>}
 */
async function transaction(capabilities, git_directory, transformation) {
    const workTree = await makeTemporaryWorkTree(capabilities);
    try {
        const store = new GitStoreClass(workTree, capabilities);
        await clone(capabilities, git_directory, workTree); // Use wrapper
        await transformation(store);
        await push(capabilities, workTree); // Use wrapper
    } finally {
        await capabilities.deleter.deleteDirectory(workTree);    
    }
}

module.exports = {
    transaction,
};
