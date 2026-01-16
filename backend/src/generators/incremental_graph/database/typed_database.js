/**
 * Typed database abstraction layer.
 * Provides a GenericDatabase interface that wraps LevelDB sublevels with strong typing.
 */

/** @typedef {import('./types').SchemaSublevelType} SchemaSublevelType */

/**
 * @template T
 * @typedef {import('./types').SimpleSublevel<T>} SimpleSublevel
 */

/**
 * @template T
 * @typedef {import('./types').DatabasePutOperation<T>} DatabasePutOperation
 */

/**
 * @template T
 * @typedef {import('./types').DatabaseDelOperation<T>} DatabaseDelOperation
 */

/**
 * @typedef {import('./types').DatabaseKey} DatabaseKey
 */

/**
 * Generic typed database interface.
 * All databases (values, freshness, inputs, revdeps) implement this interface.
 * @template TValue - The value type
 * @typedef {object} GenericDatabase
 * @property {(key: DatabaseKey) => Promise<TValue | undefined>} get - Retrieve a value
 * @property {(key: DatabaseKey, value: TValue) => Promise<void>} put - Store a value
 * @property {(key: DatabaseKey) => Promise<void>} del - Delete a value
 * @property {(key: DatabaseKey, value: TValue) => DatabasePutOperation<TValue>} putOp - Store a value operation
 * @property {(key: DatabaseKey) => DatabaseDelOperation<TValue>} delOp - Delete a value operation
 * @property {() => AsyncIterable<DatabaseKey>} keys - Iterate over all keys
 * @property {() => Promise<void>} clear - Clear all entries
 */

/**
 * Wrapper class that adapts a LevelDB sublevel to the GenericDatabase interface.
 * @template TValue
 */
class TypedDatabaseClass {
    /**
     * The underlying LevelDB sublevel instance.
     * @private
     * @type {SimpleSublevel<TValue>}
     */
    sublevel;

    /**
     * @constructor
     * @param {SimpleSublevel<TValue>} sublevel - The LevelDB sublevel instance
     */
    constructor(sublevel) {
        this.sublevel = sublevel;
    }

    /**
     * Retrieve a value from the database.
     *
     * Note: Level v10+ returns `undefined` for missing keys rather than throwing an error.
     * This is the expected behavior and we pass it through directly.
     *
     * @param {import('./types').DatabaseKey} key - The key to retrieve
     * @returns {Promise<TValue | undefined>}
     */
    async get(key) {
        return this.sublevel.get(key);
    }

    /**
     * Store a value in the database.
     * @param {DatabaseKey} key - The key to store
     * @param {TValue} value - The value to store
     * @returns {Promise<void>}
     */
    async put(key, value) {
        await this.sublevel.put(key, value);
    }

    /**
     * Delete a value from the database.
     * @param {DatabaseKey} key - The key to delete
     * @returns {Promise<void>}
     */
    async del(key) {
        await this.sublevel.del(key);
    }

    /**
     * Create a put operation for batch processing.
     * @param {DatabaseKey} key - The key to store
     * @param {TValue} value - The value to store
     * @returns {DatabasePutOperation<TValue>}
     */
    putOp(key, value) {
        return { sublevel: this.sublevel, type: "put", key, value };
    }

    /**
     * Create a delete operation for batch processing.
     * @param {DatabaseKey} key - The key to delete
     * @returns {DatabaseDelOperation<TValue>}
     */
    delOp(key) {
        /** @type {SimpleSublevel<TValue>} */
        const thisSublevel = this.sublevel;
        /** @type {SimpleSublevel<TValue>} */
        const sublevel = thisSublevel;
        return { sublevel: sublevel, type: "del", key };
    }

    /**
     * Iterate over all keys in the database.
     * @returns {AsyncIterable<DatabaseKey>}
     */
    async *keys() {
        for await (const key of this.sublevel.keys()) {
            yield key;
        }
    }

    /**
     * Clear all entries in the database.
     * @returns {Promise<void>}
     */
    async clear() {
        await this.sublevel.clear();
    }
}

/**
 * Factory function to create a TypedDatabase instance.
 * @template TValue
 * @param {SimpleSublevel<TValue>} sublevel - The LevelDB sublevel instance
 * @returns {GenericDatabase<TValue>}
 */
function makeTypedDatabase(sublevel) {
    return new TypedDatabaseClass(sublevel);
}

/**
 * Type guard for TypedDatabase.
 * @param {unknown} object
 * @returns {boolean}
 */
function isTypedDatabase(object) {
    return object instanceof TypedDatabaseClass;
}

module.exports = {
    makeTypedDatabase,
    isTypedDatabase,
};
