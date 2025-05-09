const os = require("os");
const { reset, commit } = require("./wrappers");
const fs = require("fs").promises;

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
            reset(this.gitDirectory, this.workTree);
        }
        return this.workTree;
    }

    /**
     * @param {string} message
     * @returns {Promise<void>}
     */
    async commit(message) {
        const workTree = await this.getWorkTree();
        await commit(this.gitDirectory, workTree, message);
    }
}

/**
 * This function performs a transaction on a Git repository.
 * 
 * It gives you a temporary work tree, reset to the last commit,
 * and allows you to perform a transformation on it.
 * 
 * It is atomic: if the transformation fails, the changes are not committed.
 * 
 * @param {string} git_directory - The `.git` directory
 * @param {function(string): Promise<void>} transformation - A function that takes a directory path and performs some operations on it
 * @returns {Promise<void>}
 */
async function transaction(git_directory, transformation) {
    const temporaryWorkTree = await makeTemporaryWorkTree();
    try {
        reset(git_directory, temporaryWorkTree);
        await transformation(temporaryWorkTree);
        await commit(
            git_directory,
            temporaryWorkTree,
            "Diary audio files transcribed"
        );
    } finally {
        await fs.rm(temporaryWorkTree, { recursive: true, force: true });
    }
}

module.exports = {
    transaction,
};
