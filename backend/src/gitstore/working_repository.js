//
// This module provides definitions and methods
// for working with the local copy of the git repository
// that Volodyslav uses to store events in.
//

const path = require("path");
const gitmethod = require("./wrappers");
const { git } = require("../executables");
const { withRetry } = require("../retryer");

/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../datetime').Datetime} Datetime */

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
 * @property {Datetime} datetime - Datetime utilities.
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
 * Synchronize the local repository with remote: pull if exists, else clone.
 * Then push the changes as well.
 * @param {Capabilities} capabilities
 * @param {string} workingPath - The path to the working directory.
 * @param {RemoteLocation} origin - Remote location or local location to sync with.
 * @param {{ resetToTheirs?: boolean }} [options] - Optional sync options.
 * @returns {Promise<void>}
 * @throws {WorkingRepositoryError}
 */
async function synchronize(capabilities, workingPath, origin, options) {
    const gitDir = pathToLocalRepositoryGitDir(capabilities, workingPath);
    const workDir = pathToLocalRepository(capabilities, workingPath);
    const headFile = path.join(gitDir, "HEAD");
    const remotePath = origin.url;
    const resetToTheirs = options && options.resetToTheirs;

    // Determined on the first attempt and reused across retries so that
    // the choice between force-push (first-time setup) and pull+push
    // (normal sync) stays consistent even if an individual step fails.
    /** @type {boolean|null} */
    let initialHasOrigin = null;

    /**
     * @param {{ attempt: number, retry: () => void }} args
     */
    async function synchronizeRetry({ attempt, retry }) {
        const exists = await capabilities.checker.fileExists(headFile);

        // On the first attempt, record whether origin was already configured.
        // Repos created via initializeEmptyRepository have no remote; we detect
        // that here so we can force-push instead of pulling (which would fail
        // with "refusing to merge unrelated histories").
        if (initialHasOrigin === null && exists) {
            initialHasOrigin = await capabilities.git.call(
                "-C", workDir, "-c", "safe.directory=*",
                "remote", "get-url", "origin"
            ).then(() => true).catch(() => false);
        }

        // If origin was absent on first attempt and the repo already exists,
        // ensure origin is configured before attempting any push or fetch.
        // The alreadyAdded guard handles the case where a previous retry
        // already added the remote but a subsequent operation failed.
        if (exists && initialHasOrigin === false) {
            const alreadyAdded = await capabilities.git.call(
                "-C", workDir, "-c", "safe.directory=*",
                "remote", "get-url", "origin"
            ).then(() => true).catch(() => false);
            if (!alreadyAdded) {
                await capabilities.git.call(
                    "-C", workDir, "-c", "safe.directory=*",
                    "remote", "add", "origin", remotePath
                );
            }
        }

        try {
            if (resetToTheirs) {
                if (exists) {
                    await gitmethod.fetchAndResetHard(capabilities, workDir);
                } else {
                    await gitmethod.clone(capabilities, remotePath, workDir);
                    await gitmethod.makePushable(capabilities, workDir);
                }
            } else {
                if (exists) {
                    if (initialHasOrigin === false) {
                        // Origin was absent initially: push local state to the
                        // remote so both sides share the same history going forward.
                        await gitmethod.forcePush(capabilities, workDir);
                    } else {
                        await gitmethod.pull(capabilities, workDir);
                        await gitmethod.push(capabilities, workDir);
                    }
                } else {
                    await gitmethod.clone(capabilities, remotePath, workDir);
                    await gitmethod.makePushable(capabilities, workDir);
                }
            }
        } catch (error) {
            capabilities.logger.logInfo({ repository: remotePath, error }, "Failed to synchronize repository");
            if (attempt < 100) {
                await new Promise(resolve => setTimeout(resolve, 0));
                return retry();
            }

            throw error;
        }
    }

    try {
        capabilities.logger.logInfo({ repository: remotePath }, "Synchronizing repository");
        await withRetry(capabilities, "synchronize", synchronizeRetry);
    } catch (err) {
        throw new WorkingRepositoryError(
            `Failed to synchronize repository: ${err}`,
            origin.url
        );
    }
}

/**
 * Initialize an empty Git repository.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {string} workingPath - The path to the working directory.
 */
async function initializeEmptyRepository(capabilities, workingPath) {
    const workDir = pathToLocalRepository(capabilities, workingPath);
    capabilities.logger.logInfo({ repository: workDir }, "Initializing empty repository");

    /**
     * Retry initialization of the empty repository.
     * @param {{ attempt: number, retry: () => void }} args
     */
    async function initializeEmptyRepositoryRetry({ attempt, retry }) {
        try {
            await gitmethod.init(capabilities, workDir);
        } catch {
            capabilities.logger.logInfo({ repository: workDir }, "Init command failed");
        }

        try {
            // Configure the repository to allow pushing to the current branch
            await gitmethod.makePushable(capabilities, workDir);

            // Create an empty initial commit so the repository has a master branch
            // This is required for the transaction system to work (clone operations need a branch)
            await git.call(
                "-C", workDir,
                "-c", "safe.directory=*",
                "-c", "user.name=volodyslav",
                "-c", "user.email=volodyslav",
                "commit",
                "--allow-empty",
                "--message",
                "Initial empty commit",
            );
        } catch (err) {
            capabilities.logger.logInfo({ repository: workDir }, "Repository initialization did not succeed sucessfully");
            if (attempt < 100) {
                await new Promise(resolve => setTimeout(resolve, 0));
                return retry();
            }

            throw err;
        }
    }

    try {
        await capabilities.creator.createDirectory(workDir);
        await withRetry(capabilities, "initialize empty repository: " + workDir, initializeEmptyRepositoryRetry);
    } catch (err) {
        throw new WorkingRepositoryError(
            `Failed to initialize empty repository: ${err}`,
            workDir
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
    const headFile = path.join(gitDir, "HEAD");

    if (!(await capabilities.checker.fileExists(headFile))) {
        if (initial_state === "empty") {
            await initializeEmptyRepository(capabilities, workingPath);
        } else {
            await synchronize(capabilities, workingPath, initial_state);
        }
    }

    return gitDir;
}

module.exports = {
    synchronize,
    getRepository,
    isWorkingRepositoryError,
};
