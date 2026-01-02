/**
 * Database class providing a thin interface to LevelDB operations.
 */

const { DatabaseQueryError } = require("./errors");
const { isDatabaseValue, isFreshness } = require("./types");
const { makeSublevels, getSchemaStorage } = require("./sublevels");

/** @typedef {import('./types').DatabaseValue} DatabaseValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import('./batch_types').GenericBatchOp} GenericBatchOp */
/** @typedef {import('./sublevels').DatabaseSublevels} DatabaseSublevels */
/** @typedef {import('./sublevels').ValuesLevel} ValuesLevel */
/** @typedef {import('./sublevels').FreshnessLevel} FreshnessLevel */
/** @typedef {import('./sublevels').SchemasLevel} SchemasLevel */
/** @typedef {DatabaseValue | Freshness} DatabaseStoredValue */
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
     * Typed sublevels for isolated storage.
     * @type {ValuesLevel}
     */
    values;

    /**
     * Freshness sublevel.
     * @type {FreshnessLevel}
     */
    freshness;

    /**
     * Schemas sublevel.
     * @type {SchemasLevel}
     */
    schemas;

    /**
     * @constructor
     * @param {LevelDB} db - The Level database instance
     * @param {string} databasePath - Path to the database directory
     * @param {DatabaseSublevels} sublevels - Typed sublevel structure
     */
    constructor(db, databasePath, sublevels) {
        this.db = db;
        this.databasePath = databasePath;
        this.values = sublevels.values;
        this.freshness = sublevels.freshness;
        this.schemas = sublevels.schemas;
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
     * Type-safe batch operation that uses string discriminators to route to sublevels.
     * @param {Array<GenericBatchOp>} operations
     * @returns {Promise<void>}
     * @throws {DatabaseQueryError} If the operation fails
     */
    async batchTyped(operations) {
        if (operations.length === 0) {
            return;
        }

        try {
            // Convert GenericBatchOps to sublevel-specific operations
            /** @type {Array<Promise<void>>} */
            const batchPromises = [];

            // Group operations by sublevel for efficiency
            /** @type {Array<{type: 'put' | 'del', key: string, value?: any}>} */
            const valuesOps = [];
            /** @type {Array<{type: 'put' | 'del', key: string, value?: any}>} */
            const freshnessOps = [];
            /** @type {Map<string, Array<{sublevel: 'inputs' | 'revdeps', type: 'put' | 'del', key: string, value?: any}>>} */
            const schemasOps = new Map();

            for (const op of operations) {
                if (op.sublevel === "values") {
                    if (op.type === "put") {
                        valuesOps.push({ type: "put", key: op.key, value: op.value });
                    } else {
                        valuesOps.push({ type: "del", key: op.key });
                    }
                } else if (op.sublevel === "freshness") {
                    if (op.type === "put") {
                        freshnessOps.push({ type: "put", key: op.key, value: op.value });
                    } else {
                        freshnessOps.push({ type: "del", key: op.key });
                    }
                } else if (op.sublevel === "schemas") {
                    const schemaHash = op.schemaHash;
                    if (!schemasOps.has(schemaHash)) {
                        schemasOps.set(schemaHash, []);
                    }
                    schemasOps.get(schemaHash)?.push({
                        sublevel: op.nestedSublevel,
                        type: op.type,
                        key: op.key,
                        value: op.value,
                    });
                }
            }

            // Execute batches
            if (valuesOps.length > 0) {
                batchPromises.push(this.values.batch(valuesOps, { sync: true }));
            }
            if (freshnessOps.length > 0) {
                batchPromises.push(this.freshness.batch(freshnessOps, { sync: true }));
            }
            for (const [schemaHash, ops] of schemasOps.entries()) {
                const schemaStorage = getSchemaStorage(this.schemas, schemaHash);
                /** @type {Array<{type: 'put' | 'del', key: string, value?: any}>} */
                const inputsOps = [];
                /** @type {Array<{type: 'put' | 'del', key: string, value?: any}>} */
                const revdepsOps = [];

                for (const op of ops) {
                    if (op.sublevel === "inputs") {
                        if (op.type === "put") {
                            inputsOps.push({ type: "put", key: op.key, value: op.value });
                        } else {
                            inputsOps.push({ type: "del", key: op.key });
                        }
                    } else {
                        if (op.type === "put") {
                            revdepsOps.push({ type: "put", key: op.key, value: op.value });
                        } else {
                            revdepsOps.push({ type: "del", key: op.key });
                        }
                    }
                }

                if (inputsOps.length > 0) {
                    batchPromises.push(schemaStorage.inputs.batch(inputsOps, { sync: true }));
                }
                if (revdepsOps.length > 0) {
                    batchPromises.push(schemaStorage.revdeps.batch(revdepsOps, { sync: true }));
                }
            }

            await Promise.all(batchPromises);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            throw new DatabaseQueryError(
                `Typed batch operation failed: ${error.message}`,
                this.databasePath,
                `BATCH_TYPED ${operations.length} ops`,
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
    const sublevels = makeSublevels(db);
    return new DatabaseClass(db, databasePath, sublevels);
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
