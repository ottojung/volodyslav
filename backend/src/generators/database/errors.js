/**
 * Error classes for database operations.
 */

/**
 * Base error class for database operations.
 */
class DatabaseError extends Error {
    /**
     * @param {string} message
     * @param {string} databasePath
     * @param {Error} [cause]
     */
    constructor(message, databasePath, cause) {
        super(message);
        this.name = "DatabaseError";
        this.databasePath = databasePath;
        this.cause = cause;
    }
}

/**
 * Error thrown when database initialization fails.
 */
class DatabaseInitializationError extends DatabaseError {
    /**
     * @param {string} message
     * @param {string} databasePath
     * @param {Error} [cause]
     */
    constructor(message, databasePath, cause) {
        super(message, databasePath, cause);
        this.name = "DatabaseInitializationError";
    }
}

/**
 * Error thrown when a database query fails.
 */
class DatabaseQueryError extends DatabaseError {
    /**
     * @param {string} message
     * @param {string} databasePath
     * @param {string} query
     * @param {Error} [cause]
     */
    constructor(message, databasePath, query, cause) {
        super(message, databasePath, cause);
        this.name = "DatabaseQueryError";
        this.query = query;
    }
}

/**
 * Type guard for DatabaseError.
 * @param {unknown} object
 * @returns {object is DatabaseError}
 */
function isDatabaseError(object) {
    return object instanceof DatabaseError;
}

/**
 * Type guard for DatabaseInitializationError.
 * @param {unknown} object
 * @returns {object is DatabaseInitializationError}
 */
function isDatabaseInitializationError(object) {
    return object instanceof DatabaseInitializationError;
}

/**
 * Type guard for DatabaseQueryError.
 * @param {unknown} object
 * @returns {object is DatabaseQueryError}
 */
function isDatabaseQueryError(object) {
    return object instanceof DatabaseQueryError;
}

module.exports = {
    DatabaseError,
    DatabaseInitializationError,
    DatabaseQueryError,
    isDatabaseError,
    isDatabaseInitializationError,
    isDatabaseQueryError,
};

