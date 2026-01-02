/**
 * Database class providing a thin interface to LevelDB operations.
 */

const { DatabaseQueryError } = require("./errors");
const { isDatabaseValue, isFreshness } = require("./types");

/** @typedef {import('./types').DatabaseValue} DatabaseValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {DatabaseValue | Freshness | import('./types').InputsRecord | string[]} DatabaseStoredValue */
/** @typedef {import('level').Level<string, DatabaseStoredValue>} LevelDB */
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
     * @param {DatabaseStoredValue} value - The database value or freshness to store
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
     * @returns {Promise<DatabaseStoredValue | undefined>}
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
     * Retrieves a data value from the database (not freshness).
     * @param {string} key - The key to retrieve
     * @returns {Promise<DatabaseValue | undefined>}
     * @throws {DatabaseQueryError} If the operation fails
     */
    async getValue(key) {
        const result = await this.get(key);
        if (result === undefined) {
            return undefined;
        }
        if (isDatabaseValue(result)) {
            return result;
        } else {
            throw new DatabaseQueryError(
                `Expected database value for key ${key}, but found something else.`,
                this.databasePath,
                `GET ${key}`
            );
        }
    }

    /**
     * Retrieves a freshness state from the database.
     * @param {string} key - The freshness key to retrieve
     * @returns {Promise<Freshness | undefined>}
     * @throws {DatabaseQueryError} If the operation fails
     */
    async getFreshness(key) {
        const result = await this.get(key);
        if (result === undefined) {
            return undefined;
        }
        if (isFreshness(result)) {
            return result;
        } else {
            throw new DatabaseQueryError(
                `Expected freshness for key ${key}, but found something else.`,
                this.databasePath,
                `GET ${key}`
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
    async keys(prefix = "") {
        try {
            const keys = [];
            for await (const key of this.db.keys({
                gte: prefix,
                lt: prefix + "\xFF",
            })) {
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
     * @returns {Promise<Array<DatabaseStoredValue>>}
     * @throws {DatabaseQueryError} If the operation fails
     */
    async getAll(prefix = "") {
        try {
            /** @type {Array<DatabaseStoredValue>} */
            const values = [];
            for await (const [, value] of this.db.iterator({
                gte: prefix,
                lt: prefix + "\xFF",
            })) {
                // Trust that the database only contains valid DatabaseStoredValue types
                // since we control all writes through the put() method
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
     * @param {Array<DatabaseBatchOperation>} operations
     * @returns {Promise<void>}
     * @throws {DatabaseQueryError} If the operation fails
     */
    async batch(operations) {
        if (operations.length === 0) {
            return;
        }
        try {
            await this.db.batch(operations, { sync: true });
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
                "CLOSE",
                error
            );
        }
    }
}

const { Level } = require("level");

/**
 * Factory function to create a Database instance.
 * @param {string} databasePath - Path to the database directory
 * @returns {Promise<DatabaseClass>}
 */
async function makeDatabase(databasePath) {
    const db =
        /** @type {import('level').Level<string, DatabaseStoredValue>} */ (
            new Level(databasePath, { valueEncoding: "json" })
        );
    await db.open();
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
