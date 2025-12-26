/**
 * Database class providing a thin interface to SQLite operations.
 */

const { DatabaseQueryError } = require('./errors');

/** @typedef {import('better-sqlite3').Database} BetterSqliteDatabase */
/** @typedef {import('./types').DatabaseCapabilities} DatabaseCapabilities */

/**
 * A thin wrapper around better-sqlite3 database operations.
 * Provides a consistent async interface for common database operations.
 */
class DatabaseClass {
    /**
     * The underlying better-sqlite3 database instance.
     * @private
     * @type {BetterSqliteDatabase}
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
     * @param {BetterSqliteDatabase} db - The better-sqlite3 database instance
     * @param {string} databasePath - Path to the database file
     */
    constructor(db, databasePath) {
        this.db = db;
        this.databasePath = databasePath;
    }

    /**
     * Runs a SQL query that doesn't return results (INSERT, UPDATE, DELETE, etc.).
     * @param {string} query - The SQL query to execute
     * @param {any[]} [params] - Query parameters
     * @returns {Promise<void>}
     * @throws {DatabaseQueryError} If the query fails
     */
    async run(query, params = []) {
        try {
            this.db.prepare(query).run(...params);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            throw new DatabaseQueryError(
                `Query execution failed: ${error.message}`,
                this.databasePath,
                query,
                error
            );
        }
    }

    /**
     * Executes a SQL query and returns all matching rows.
     * @param {string} query - The SQL query to execute
     * @param {any[]} [params] - Query parameters
     * @returns {Promise<any[]>}
     * @throws {DatabaseQueryError} If the query fails
     */
    async all(query, params = []) {
        try {
            return this.db.prepare(query).all(...params);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            throw new DatabaseQueryError(
                `Query execution failed: ${error.message}`,
                this.databasePath,
                query,
                error
            );
        }
    }

    /**
     * Executes a SQL query and returns the first matching row.
     * @param {string} query - The SQL query to execute
     * @param {any[]} [params] - Query parameters
     * @returns {Promise<any | undefined>}
     * @throws {DatabaseQueryError} If the query fails
     */
    async get(query, params = []) {
        try {
            return this.db.prepare(query).get(...params);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            throw new DatabaseQueryError(
                `Query execution failed: ${error.message}`,
                this.databasePath,
                query,
                error
            );
        }
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
        try {
            this.db.close();
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            throw new DatabaseQueryError(
                `Failed to close database: ${error.message}`,
                this.databasePath,
                'CLOSE',
                error
            );
        }
    }
}

/**
 * Factory function to create a Database instance.
 * @param {BetterSqliteDatabase} db - The better-sqlite3 database instance
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
