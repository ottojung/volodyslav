const os = require("os");
const fs = require("fs").promises;
const { git } = require("../executables");

async function makeTemporaryWorkTree() {
    return await fs.mkdtemp(`${os.tmpdir()}/gitstore-`);
}

class GitStoreClass {
    /**
     * @param {string} gitDirectory
     */
    constructor(gitDirectory) {
        this.gitDirectory = gitDirectory;
        this.workTree = null;
    }

    /**
     * @returns {Promise<string>}
     */
    async getWorkTree() {
        if (!this.workTree) {
            this.workTree = await makeTemporaryWorkTree();
            
            // Initialize the work tree with repository content
            // Copy the repository content to the work tree
            await git.call(
                "--git-dir",
                this.gitDirectory,
                "checkout-index",
                "-a",
                "--prefix=" + this.workTree + "/"
            );
            
            // Then reset it to ensure it's clean
            await git.call(
                "--git-dir",
                this.gitDirectory,
                "--work-tree",
                this.workTree,
                "reset",
                "--hard",
                "HEAD"
            );
        }
        return this.workTree;
    }

    /**
     * @param {string} message
     * @returns {Promise<void>}
     */
    async commit(message) {
        const workTree = await this.getWorkTree();
        // Stage all changes before committing
        await git.call(
            "--git-dir",
            this.gitDirectory,
            "--work-tree",
            workTree,
            "add",
            "."
        );
        // Then commit
        await git.call(
            "--git-dir",
            this.gitDirectory,
            "--work-tree",
            workTree,
            "commit",
            "--message",
            message);
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
 * @param {string} git_directory - The `.git` directory
 * @param {function(GitStore): Promise<void>} transformation - A function that takes a directory path and performs some operations on it
 * @returns {Promise<void>}
 */
async function transaction(git_directory, transformation) {
    const store = new GitStoreClass(git_directory);
    try {
        await store.getWorkTree(); // Ensure work tree is created and reset
        await transformation(store);
    } finally {
        if (store.workTree) {
            await fs.rm(store.workTree, { recursive: true, force: true });
            store.workTree = null;
        }
    }
}

module.exports = {
    transaction,
};
