const { commit, push, clone, isPushError } = require("./wrappers");
const path = require("path");
const workingRepository = require("./working_repository");
const timeDuration = require("../time_duration");

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
 * @property {import('../sleeper').Sleeper} [sleeper] - A sleeper instance (optional, defaults to no-op).
 */

/**
 * @typedef {object} RetryOptions
 * @property {number} maxAttempts - Maximum number of retry attempts
 * @property {number} delayMs - Delay in milliseconds
 */

/**
 * Default retry configuration
 * @type {RetryOptions}
 */
const DEFAULT_RETRY_OPTIONS = {
    maxAttempts: 5,
    delayMs: 0,
};

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
 * Executes a single transaction attempt.
 * @template T
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {string} workingPath - Path to the working directory (local repository)
 * @param {RemoteLocation | "empty"} initial_state - Remote location to sync with, or "empty" for local-only
 * @param {function(GitStore): Promise<T>} transformation - A function that takes a directory path and performs some operations on it
 * @returns {Promise<T>}
 */
async function executeTransactionAttempt(capabilities, workingPath, initial_state, transformation) {
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

/**
 * This function performs a transaction on a Git repository.
 *
 * It gives you a temporary work tree, reset to the last commit,
 * and allows you to perform a transformation on it.
 *
 * It is atomic: if the transformation fails, the changes are not committed.
 * Caveat: if you are calling commit() multiple times, they won't necessarily be consequtive.
 *
 * When push fails, the entire workflow will be retried up to the configured number of attempts.
 * Non-push failures are not retried.
 *
 * @template T
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {string} workingPath - Path to the working directory (local repository)
 * @param {RemoteLocation | "empty"} initial_state - Remote location to sync with, or "empty" for local-only
 * @param {function(GitStore): Promise<T>} transformation - A function that takes a directory path and performs some operations on it
 * @param {RetryOptions} [retryOptions] - Retry configuration options
 * @returns {Promise<T>}
 */
async function transaction(capabilities, workingPath, initial_state, transformation, retryOptions = DEFAULT_RETRY_OPTIONS) {
    const options = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
    let lastError = null;
    
    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
        try {
            capabilities.logger.logDebug(
                { 
                    attempt, 
                    maxAttempts: options.maxAttempts,
                    workingPath,
                    initialState: initial_state === "empty" ? "empty" : initial_state.url
                },
                `Gitstore transaction attempt ${attempt}/${options.maxAttempts}`
            );
            
            const result = await executeTransactionAttempt(capabilities, workingPath, initial_state, transformation);
            
            if (attempt > 1) {
                capabilities.logger.logInfo(
                    { 
                        attempt, 
                        totalAttempts: attempt,
                        workingPath 
                    },
                    `Gitstore transaction succeeded on attempt ${attempt} after previous failures`
                );
            }
            
            return result;
        } catch (error) {
            lastError = error;
            
            // Only retry push errors
            if (!isPushError(error)) {
                capabilities.logger.logDebug(
                    { 
                        attempt,
                        errorType: error instanceof Error ? error.name : 'Unknown',
                        errorMessage: error instanceof Error ? error.message : String(error),
                        workingPath
                    },
                    `Gitstore transaction failed with non-push error - not retrying`
                );
                throw error;
            }
            
            if (attempt === options.maxAttempts) {
                capabilities.logger.logError(
                    { 
                        attempt,
                        maxAttempts: options.maxAttempts,
                        errorMessage: error instanceof Error ? error.message : String(error),
                        workingPath
                    },
                    `Gitstore transaction failed after ${options.maxAttempts} attempts - giving up`
                );
                break;
            }

            const delayMs = options.delayMs;
            const delay = timeDuration.fromMilliseconds(delayMs);
            
            capabilities.logger.logInfo(
                { 
                    attempt,
                    maxAttempts: options.maxAttempts,
                    retryDelay: delay.toString(),
                    errorMessage: error instanceof Error ? error.message : String(error),
                    workingPath
                },
                `Gitstore push failed on attempt ${attempt} - retrying after ${delay.toString()}`
            );
            
            if (capabilities.sleeper) {
                await capabilities.sleeper.sleep(delayMs);
            } else {
                // Fallback: use setTimeout when sleeper is not available
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
    
    // If we get here, all retries failed
    throw lastError;
}

module.exports = {
    transaction,
};
