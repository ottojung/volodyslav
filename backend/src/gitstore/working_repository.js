//
// This module provides definitions and methods
// for working with the local copy of the git repository
// that Volodyslav uses to store events in.
//

const path = require("path");
const gitmethod = require("./wrappers");

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
 * Custom error for WorkingRepository operations.
 */
class WorkingRepositoryError extends Error {
    /**
     * @param {string} message
     * @param {string} repositoryPath
     */
    constructor(message, repositoryPath) {
        super(message);
        this.name = "WorkingRepositoryError";
        this.repositoryPath = repositoryPath;
    }
}

/**
 * Type guard for WorkingRepositoryError.
 * @param {unknown} object - The object to check.
 * @returns {object is WorkingRepositoryError}
 */
function isWorkingRepositoryError(object) {
    return object instanceof WorkingRepositoryError;
}

/**
 * Get local repository path.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {string} workingPath - The path to the working directory.
 * @returns {string} - The absolute path to the local git repository.
 */
function pathToLocalRepository(capabilities, workingPath) {
    const wd = capabilities.environment.workingDirectory();
    return path.join(wd, workingPath);
}

/**
 * Get the path to the local repository's .git directory.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {string} workingPath - The path to the working directory.
 * @returns {string} - The absolute path to the .git directory.
 */
function pathToLocalRepositoryGitDir(capabilities, workingPath) {
    return path.join(pathToLocalRepository(capabilities, workingPath), ".git");
}

/**
 * Initialize an empty local repository.
 * @param {Capabilities} capabilities
 * @param {string} workDir - The path to the working directory.
 * @returns {Promise<void>}
 * @throws {WorkingRepositoryError}
 */
async function initializeEmptyRepository(capabilities, workDir) {
    try {
        await capabilities.creator.createDirectory(workDir);
        await gitmethod.init(capabilities, workDir);
        
        // Configure the repository to allow pushing to the current branch
        await capabilities.git.call(
            "-C",
            workDir,
            "config",
            "receive.denyCurrentBranch",
            "updateInstead"
        );
        
        // Create an initial commit so the repository has a master branch
        const readmeFile = path.join(workDir, "README.md");
        const file = await capabilities.creator.createFile(readmeFile);
        await capabilities.writer.writeFile(
            file,
            "# Local Repository\n\nThis is a local-only git repository."
        );
        
        // Add and commit the initial file
        await capabilities.git.call("-C", workDir, "add", "--all");
        await capabilities.git.call(
            "-C",
            workDir,
            "-c",
            "user.name=volodyslav",
            "-c",
            "user.email=volodyslav",
            "commit",
            "-m",
            "Initial commit"
        );
    } catch (err) {
        throw new WorkingRepositoryError(
            `Failed to initialize empty repository: ${err}`,
            workDir
        );
    }
}

/**
 * Synchronize the local repository with remote: pull if exists, else clone.
 * Then push the changes as well. For "empty" initial_state, initialize an empty repository.
 * @param {Capabilities} capabilities
 * @param {string} workingPath - The path to the working directory.
 * @param {RemoteLocation | "empty"} initial_state - Remote location to sync with, or "empty" for local-only
 * @returns {Promise<void>}
 * @throws {WorkingRepositoryError}
 */
async function synchronize(capabilities, workingPath, initial_state) {
    const gitDir = pathToLocalRepositoryGitDir(capabilities, workingPath);
    const workDir = pathToLocalRepository(capabilities, workingPath);
    const indexFile = path.join(gitDir, "index");
    
    try {
        if (initial_state === "empty") {
            capabilities.logger.logInfo({ repository: workDir }, "Initializing empty repository");
            await initializeEmptyRepository(capabilities, workDir);
        } else {
            const remotePath = initial_state.url;
            capabilities.logger.logInfo({ repository: remotePath }, "Synchronizing repository");
            if (await capabilities.checker.fileExists(indexFile)) {
                await gitmethod.pull(capabilities, workDir);
                await gitmethod.push(capabilities, workDir);
            } else {
                // TODO: rollback if any of the following operations fail.
                await gitmethod.clone(capabilities, remotePath, workDir);
                await gitmethod.makePushable(capabilities, workDir);
            }
        }
    } catch (err) {
        const repoPath = initial_state === "empty" ? workDir : initial_state.url;
        throw new WorkingRepositoryError(
            `Failed to synchronize repository: ${err}`,
            repoPath
        );
    }
}

/**
 * Ensure the repository is present locally and return its path.
 * Note: returns the path to the `.git` directory.
 * @param {Capabilities} capabilities
 * @param {string} workingPath - The path to the working directory.
 * @param {RemoteLocation | "empty"} initial_state - Remote location to sync with, or "empty" for local-only
 * @returns {Promise<string>}
 * @throws {WorkingRepositoryError}
 */
async function getRepository(capabilities, workingPath, initial_state) {
    const gitDir = pathToLocalRepositoryGitDir(capabilities, workingPath);
    const indexFile = path.join(gitDir, "index");

    if (!(await capabilities.checker.fileExists(indexFile))) {
        await synchronize(capabilities, workingPath, initial_state);
    }

    return gitDir;
}

module.exports = {
    synchronize,
    getRepository,
    isWorkingRepositoryError,
};
