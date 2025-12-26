/**
 * Database class providing a thin interface to SQLite operations.
 */

const { DatabaseQueryError } = require('./errors');

/** @typedef {import('sqlite3').Database} SQLiteDatabase */
/** @typedef {import('./types').DatabaseCapabilities} DatabaseCapabilities */

/**
 * A thin wrapper around SQLite database operations.
 * Provides Promise-based interfaces to common SQLite operations.
 */
class DatabaseClass {
    /**
     * The underlying SQLite database instance.
     * @private
     * @type {SQLiteDatabase}
     */
    db;

    /**
     * Path to the database file.
     * @private
     * @type {string}
     */
    databasePath;

    /**
     * @constructor
     * @param {SQLiteDatabase} db - The SQLite database instance
     * @param {string} databasePath - Path to the database file
     */
    constructor(db, databasePath) {
        this.db = db;
        this.databasePath = databasePath;
    }

    /**
     * Runs a SQL query that doesn't return results (INSERT, UPDATE, DELETE, etc.).
     * @param {string} query - The SQL query to execute
     * @param {unknown[]} [params] - Query parameters
     * @returns {Promise<void>}
     * @throws {DatabaseQueryError} If the query fails
     */
    async run(query, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(query, params, (err) => {
                if (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    reject(new DatabaseQueryError(
                        `Query execution failed: ${error.message}`,
                        this.databasePath,
                        query,
                        error
                    ));
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Executes a SQL query and returns all matching rows.
     * @template T
     * @param {string} query - The SQL query to execute
     * @param {unknown[]} [params] - Query parameters
     * @returns {Promise<T[]>}
     * @throws {DatabaseQueryError} If the query fails
     */
    async all(query, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(query, params, (err, rows) => {
                if (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    reject(new DatabaseQueryError(
                        `Query execution failed: ${error.message}`,
                        this.databasePath,
                        query,
                        error
                    ));
                } else {
                    resolve(rows);
                }
            });
        });
    }

    /**
     * Executes a SQL query and returns the first matching row.
     * @template T
     * @param {string} query - The SQL query to execute
     * @param {unknown[]} [params] - Query parameters
     * @returns {Promise<T | undefined>}
     * @throws {DatabaseQueryError} If the query fails
     */
    async get(query, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(query, params, (err, row) => {
                if (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    reject(new DatabaseQueryError(
                        `Query execution failed: ${error.message}`,
                        this.databasePath,
                        query,
                        error
                    ));
                } else {
                    resolve(row);
                }
            });
        });
    }

    /**
     * Executes a callback within a database transaction.
     * If the callback throws an error, the transaction is rolled back.
     * @template T
     * @param {() => Promise<T>} callback - The callback to execute within the transaction
     * @returns {Promise<T>}
     * @throws {DatabaseQueryError} If the transaction fails
     */
    async transaction(callback) {
        await this.run('BEGIN TRANSACTION');
        try {
            const result = await callback();
            await this.run('COMMIT');
            return result;
        } catch (error) {
            await this.run('ROLLBACK');
            throw error;
        }
    }

    /**
     * Closes the database connection.
     * @returns {Promise<void>}
     */
    async close() {
        return new Promise((resolve, reject) => {
            this.db.close((err) => {
                if (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    reject(new DatabaseQueryError(
                        `Failed to close database: ${error.message}`,
                        this.databasePath,
                        'CLOSE',
                        error
                    ));
                } else {
                    resolve();
                }
            });
        });
    }
}

/**
 * Factory function to create a Database instance.
 * @param {SQLiteDatabase} db - The SQLite database instance
 * @param {string} databasePath - Path to the database file
 * @returns {DatabaseClass}
 */
function makeDatabase(db, databasePath) {
    return new DatabaseClass(db, databasePath);
}

/**
 * Type guard for Database.
 * @param {unknown} object
 * @returns {object is DatabaseClass}
 */
function isDatabase(object) {
    return object instanceof DatabaseClass;
}

/** @typedef {DatabaseClass} Database */

module.exports = {
    makeDatabase,
    isDatabase,
};
