/**
 * Database class providing a thin interface to libsql operations.
 */

const { DatabaseQueryError } = require('./errors');

/** @typedef {import('@libsql/client').Client} LibsqlClient */
/** @typedef {import('./types').DatabaseCapabilities} DatabaseCapabilities */

/**
 * A thin wrapper around libsql database operations.
 * Provides a consistent interface for common database operations.
 */
class DatabaseClass {
    /**
     * The underlying libsql client instance.
     * @private
     * @type {LibsqlClient}
     */
    client;

    /**
     * Path to the database file.
     * @private
     * @type {string}
     */
    databasePath;

    /**
     * @constructor
     * @param {LibsqlClient} client - The libsql client instance
     * @param {string} databasePath - Path to the database file
     */
    constructor(client, databasePath) {
        this.client = client;
        this.databasePath = databasePath;
    }

    /**
     * Runs a SQL query that doesn't return results (INSERT, UPDATE, DELETE, etc.).
     * @param {string} query - The SQL query to execute
     * @param {import('@libsql/client').InArgs} [params] - Query parameters
     * @returns {Promise<void>}
     * @throws {DatabaseQueryError} If the query fails
     */
    async run(query, params = []) {
        try {
            await this.client.execute({ sql: query, args: params });
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
     * @param {import('@libsql/client').InArgs} [params] - Query parameters
     * @returns {Promise<import('@libsql/client').Row[]>}
     * @throws {DatabaseQueryError} If the query fails
     */
    async all(query, params = []) {
        try {
            const result = await this.client.execute({ sql: query, args: params });
            return result.rows;
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
     * @param {import('@libsql/client').InArgs} [params] - Query parameters
     * @returns {Promise<import('@libsql/client').Row | undefined>}
     * @throws {DatabaseQueryError} If the query fails
     */
    async get(query, params = []) {
        try {
            const result = await this.client.execute({ sql: query, args: params });
            return result.rows[0];
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
            this.client.close();
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
 * @param {LibsqlClient} client - The libsql client instance
 * @param {string} databasePath - Path to the database file
 * @returns {DatabaseClass}
 */
function makeDatabase(client, databasePath) {
    return new DatabaseClass(client, databasePath);
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
