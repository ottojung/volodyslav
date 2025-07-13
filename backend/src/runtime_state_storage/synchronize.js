const path = require("path");
const workingRepository = require("../gitstore/working_repository");

/** @typedef {import('./types').Capabilities} Capabilities */

/**
 * Custom error for runtime state repository operations.
 */
class RuntimeStateRepositoryError extends Error {
    /**
     * @param {string} message
     * @param {string} repositoryPath
     */
    constructor(message, repositoryPath) {
        super(message);
        this.name = "RuntimeStateRepositoryError";
        this.repositoryPath = repositoryPath;
    }
}

/**
 * Type guard for RuntimeStateRepositoryError.
 * @param {unknown} object
 * @returns {object is RuntimeStateRepositoryError}
 */
function isRuntimeStateRepositoryError(object) {
    return object instanceof RuntimeStateRepositoryError;
}

/**
 * Synchronizes the runtime state repository.
 * Since this is a local-only repository, we use "empty" initial state.
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function synchronize(capabilities) {
    try {
        await workingRepository.synchronize(capabilities, "runtime-state-repository", "empty");
    } catch (error) {
        if (workingRepository.isWorkingRepositoryError(error)) {
            throw new RuntimeStateRepositoryError(
                `Failed to synchronize runtime state repository: ${error.message}`,
                error.repositoryPath
            );
        }
        throw error;
    }
}

/**
 * Ensures the runtime state repository is accessible locally.
 * @param {Capabilities} capabilities
 * @returns {Promise<string>} The path to the .git directory
 */
async function ensureAccessible(capabilities) {
    try {
        return await workingRepository.getRepository(capabilities, "runtime-state-repository", "empty");
    } catch (error) {
        if (workingRepository.isWorkingRepositoryError(error)) {
            throw new RuntimeStateRepositoryError(
                `Failed to ensure runtime state repository is accessible: ${error.message}`,
                error.repositoryPath
            );
        }
        throw error;
    }
}

module.exports = { synchronize, ensureAccessible, isRuntimeStateRepositoryError };
