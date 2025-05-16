const os = require("os");
const { commit, push, clone } = require("./wrappers");
const path = require("path");
const fs = require("fs").promises;

/** @typedef {import('../subprocess/command').Command} Command */

/**
 * @typedef {object} Capabilities
 * @property {Command} git - A command instance for Git operations.
 */

async function makeTemporaryWorkTree() {
    return await fs.mkdtemp(`${os.tmpdir()}/gitstore-`);
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
        // TODO: This is a placeholder. The actual git command should be used here.
        // This will require the 'Command' type to be properly integrated.
        // For now, we'll keep the existing call to the wrapper.
        // In a subsequent step, we would replace this with something like:
        // await this.capabilities.git.run(...) 
        await commit(gitDir, workTree, message);
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
    const workTree = await makeTemporaryWorkTree();
    try {
        const store = new GitStoreClass(workTree, capabilities);
        // TODO: Similar to the commit method, these git operations (clone, push)
        // should ideally use the capabilities.git command.
        // For now, we'll keep the existing calls to the wrappers.
        await clone(git_directory, workTree);
        await transformation(store);
        await push(workTree);
    } finally {
        await fs.rm(workTree, { recursive: true, force: true });
    }
}

module.exports = {
    transaction,
};
