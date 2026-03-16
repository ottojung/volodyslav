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
 * Error raised when data.json cannot be read.
 */
class ExistingEntriesReadError extends EventLogStorageReadError {
    /**
     * @param {string} filepath
     * @param {unknown} cause
     */
    constructor(filepath, cause) {
        const causeMessage =
            cause instanceof Error ? cause.message : String(cause);
        super(
            `Failed to read existing entries from ${filepath}: ${causeMessage}`,
            filepath,
            cause
        );
        this.name = "ExistingEntriesReadError";
    }
}

/**
 * @param {unknown} object
 * @returns {object is ExistingEntriesReadError}
 */
function isExistingEntriesReadError(object) {
    return object instanceof ExistingEntriesReadError;
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

/**
 * Error raised when a specific entry in data.json fails deserialization.
 */
class MalformedEntryError extends ExistingEntriesReadError {
    /**
     * @param {string} filepath
     * @param {unknown} cause
     * @param {unknown} invalidObject
     */
    constructor(filepath, cause, invalidObject) {
        super(filepath, cause);
        this.name = "MalformedEntryError";
        this.invalidObject = invalidObject;
    }
}

/**
 * @param {unknown} object
 * @returns {object is MalformedEntryError}
 */
function isMalformedEntryError(object) {
    return object instanceof MalformedEntryError;
}

module.exports = {
    ExistingConfigReadError,
    ExistingEntriesReadError,
    MalformedEntryError,
    isEventLogStorageReadError,
    isExistingConfigReadError,
    isExistingEntriesReadError,
    isMalformedEntryError,
};
