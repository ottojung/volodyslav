
/** @typedef {import('./types').RuntimeStateStorageCapabilities} RuntimeStateStorageCapabilities */

/**
 * Custom error for runtime state storage accessibility failures.
 */
class RuntimeStateStorageAccessError extends Error {
    /**
     * @param {string} message
     * @param {Error} [cause]
     */
    constructor(message, cause) {
        super(message);
        this.name = "RuntimeStateStorageAccessError";
        this.cause = cause;
    }
}

/**
 * Type guard for RuntimeStateStorageAccessError.
 * @param {unknown} object
 * @returns {object is RuntimeStateStorageAccessError}
 */
function isRuntimeStateStorageAccessError(object) {
    return object instanceof RuntimeStateStorageAccessError;
}


/**
 * Ensures the runtime state storage (temporary DB) is accessible.
 * @param {RuntimeStateStorageCapabilities} capabilities
 * @returns {Promise<void>}
 */
async function ensureAccessible(capabilities) {
    try {
        await capabilities.temporary.getRuntimeState();
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new RuntimeStateStorageAccessError(
            `Failed to ensure runtime state storage is accessible: ${err.message}`,
            err
        );
    }
}

module.exports = { ensureAccessible, isRuntimeStateStorageAccessError };
