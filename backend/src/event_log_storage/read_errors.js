/**
 * Error raised when reading persisted event-log state fails.
 */
class EventLogStorageReadError extends Error {
    /**
     * @param {string} message
     * @param {string} filepath
     * @param {unknown} cause
     */
    constructor(message, filepath, cause) {
        super(message);
        this.name = "EventLogStorageReadError";
        this.filepath = filepath;
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is EventLogStorageReadError}
 */
function isEventLogStorageReadError(object) {
    return object instanceof EventLogStorageReadError;
}

/**
 * Error raised when config.json cannot be read.
 */
class ExistingConfigReadError extends EventLogStorageReadError {
    /**
     * @param {string} filepath
     * @param {unknown} cause
     */
    constructor(filepath, cause) {
        const causeMessage =
            cause instanceof Error ? cause.message : String(cause);
        super(
            `Failed to read existing config from ${filepath}: ${causeMessage}`,
            filepath,
            cause
        );
        this.name = "ExistingConfigReadError";
    }
}

/**
 * @param {unknown} object
 * @returns {object is ExistingConfigReadError}
 */
function isExistingConfigReadError(object) {
    return object instanceof ExistingConfigReadError;
}

module.exports = {
    ExistingConfigReadError,
    isEventLogStorageReadError,
    isExistingConfigReadError,
};
