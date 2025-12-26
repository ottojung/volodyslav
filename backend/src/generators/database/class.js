/**
 * Database class providing a thin interface to LevelDB operations.
 */

const { DatabaseQueryError } = require('./errors');

/** @typedef {import('level').Level<string, object>} LevelDB */
/** @typedef {import('./types').DatabaseCapabilities} DatabaseCapabilities */

/**
 * A thin wrapper around LevelDB database operations.
 * Provides async key-value storage for events and modifiers.
 */
class DatabaseClass {
    /**
     * The underlying Level database instance.
     * @private
     * @type {LevelDB}
     */
    db;

    /**
     * Path to the database directory.
     * @private
     * @type {string}
     */
    databasePath;

    /**
     * @constructor
     * @param {LevelDB} db - The Level database instance
     * @param {string} databasePath - Path to the database directory
     */
    constructor(db, databasePath) {
        this.db = db;
        this.databasePath = databasePath;
    }

    /**
     * Stores a value in the database.
     * @param {string} key - The key to store
     * @param {object} value - The value to store
     * @returns {Promise<void>}
     * @throws {DatabaseQueryError} If the operation fails
     */
    async put(key, value) {
        try {
            await this.db.put(key, value);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            throw new DatabaseQueryError(
                `Put operation failed: ${error.message}`,
                this.databasePath,
                `PUT ${key}`,
                error
            );
        }
    }

    /**
     * Retrieves a value from the database.
     * @param {string} key - The key to retrieve
     * @returns {Promise<object | undefined>}
     * @throws {DatabaseQueryError} If the operation fails (except for NotFoundError)
     */
    async get(key) {
        try {
            const value = await this.db.get(key);
            return value;
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            throw new DatabaseQueryError(
                `Get operation failed: ${error.message}`,
                this.databasePath,
                `GET ${key}`,
                error
            );
        }
    }

    /**
     * Deletes a value from the database.
     * @param {string} key - The key to delete
     * @returns {Promise<void>}
     * @throws {DatabaseQueryError} If the operation fails
     */
    async del(key) {
        try {
            await this.db.del(key, { sync: true });
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            throw new DatabaseQueryError(
                `Delete operation failed: ${error.message}`,
                this.databasePath,
                `DEL ${key}`,
                error
            );
        }
    }

    /**
     * Returns all keys with the given prefix.
     * @param {string} prefix - The key prefix to search for
     * @returns {Promise<string[]>}
     * @throws {DatabaseQueryError} If the operation fails
     */
    async keys(prefix = '') {
        try {
            const keys = [];
            for await (const key of this.db.keys({ gte: prefix, lt: prefix + '\xFF' })) {
                keys.push(key);
            }
            return keys;
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            throw new DatabaseQueryError(
                `Keys operation failed: ${error.message}`,
                this.databasePath,
                `KEYS ${prefix}*`,
                error
            );
        }
    }

    /**
     * Returns all values with keys matching the given prefix.
     * @param {string} prefix - The key prefix to search for
     * @returns {Promise<object[]>}
     * @throws {DatabaseQueryError} If the operation fails
     */
    async getAll(prefix = '') {
        try {
            const values = [];
            for await (const [, value] of this.db.iterator({ gte: prefix, lt: prefix + '\xFF' })) {
                values.push(value);
            }
            return values;
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            throw new DatabaseQueryError(
                `GetAll operation failed: ${error.message}`,
                this.databasePath,
                `GETALL ${prefix}*`,
                error
            );
        }
    }

    /**
     * Executes multiple operations in a batch.
     * @param {Array<{type: 'put' | 'del', key: string, value?: object}>} operations
     * @returns {Promise<void>}
     * @throws {DatabaseQueryError} If the operation fails
     */
    async batch(operations) {
        try {
            const batchOps = operations.map(op => {
                if (op.type === 'put') {                    if (!op.value) {
                        throw new Error('Put operation requires a value');
                    }                    return { type: /** @type {const} */ ('put'), key: op.key, value: op.value };
                } else {
                    return { type: /** @type {const} */ ('del'), key: op.key, options: { sync: true } };
                }
            });
            await this.db.batch(batchOps);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            throw new DatabaseQueryError(
                `Batch operation failed: ${error.message}`,
                this.databasePath,
                `BATCH ${operations.length} ops`,
                error
            );
        }
    }

    /**
     * Closes the database connection.
     * @returns {Promise<void>}
     */
    async close() {
        try {
            await this.db.close();
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
 * @param {LevelDB} db - The Level database instance
 * @param {string} databasePath - Path to the database directory
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
