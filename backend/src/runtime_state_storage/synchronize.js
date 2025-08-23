
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
 * Ensures the runtime state repository is accessible locally.
 * @param {Capabilities} capabilities
 * @returns {Promise<void>} The path to the .git directory
 */
async function ensureAccessible(capabilities) {
    try {
        await workingRepository.getRepository(capabilities, "runtime-state-repository", "empty");
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

module.exports = { ensureAccessible, isRuntimeStateRepositoryError };
