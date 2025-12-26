/**
 * Error classes for database operations.
 */

class DatabaseError extends Error {
    /**
     * @param {string} message
     * @param {string} databasePath
     */
    constructor(message, databasePath) {
        super(message);
        this.name = "DatabaseError";
        this.databasePath = databasePath;
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

class DatabaseInitializationError extends DatabaseError {
    /**
     * @param {string} message
     * @param {string} databasePath
     * @param {Error} cause
     */
    constructor(message, databasePath, cause) {
        super(message, databasePath);
        this.name = "DatabaseInitializationError";
        this.cause = cause;
    }
}

/**
 * Type guard for DatabaseInitializationError.
 * @param {unknown} object
 * @returns {object is DatabaseInitializationError}
 */
function isDatabaseInitializationError(object) {
    return object instanceof DatabaseInitializationError;
}

class DatabaseQueryError extends DatabaseError {
    /**
     * @param {string} message
     * @param {string} databasePath
     * @param {string} query
     * @param {Error} cause
     */
    constructor(message, databasePath, query, cause) {
        super(message, databasePath);
        this.name = "DatabaseQueryError";
        this.query = query;
        this.cause = cause;
    }
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
    isDatabaseError,
    DatabaseInitializationError,
    isDatabaseInitializationError,
    DatabaseQueryError,
    isDatabaseQueryError,
};
