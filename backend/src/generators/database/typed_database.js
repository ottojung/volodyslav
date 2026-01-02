/**
 * Typed database abstraction layer.
 * Provides a GenericDatabase interface that wraps LevelDB sublevels with strong typing.
 */

/**
 * Generic typed database interface.
 * All databases (values, freshness, inputs, revdeps) implement this interface.
 * @template TValue - The value type
 * @typedef {object} GenericDatabase
 * @property {(key: string) => Promise<TValue | undefined>} get - Retrieve a value
 * @property {(key: string, value: TValue) => Promise<void>} put - Store a value
 * @property {(key: string) => Promise<void>} del - Delete a value
 * @property {(key: string, value: TValue) => { db: SimpleSublevel<string, TValue>, op: 'put', key: string, value: TValue }} putOp - Store a value operation
 * @property {(key: string) => { db: SimpleSublevel<string, TValue>, op: 'del', key: string }} delOp - Delete a value operation
 * @property {() => AsyncIterable<string>} keys - Iterate over all keys
 * @property {() => Promise<void>} clear - Clear all entries
 */

/**
 * Wrapper class that adapts a LevelDB sublevel to the GenericDatabase interface.
 * @template TKey
 * @template TValue
 */
class TypedDatabaseClass {
    /**
     * The underlying LevelDB sublevel instance.
     * @private
     * @type {SimpleSublevel<TKey, TValue>}
     */
    sublevel;

    /**
     * @constructor
     * @param {SimpleSublevel<TKey, TValue>} sublevel - The LevelDB sublevel instance
     */
    constructor(sublevel) {
        this.sublevel = sublevel;
    }

    /**
     * Retrieve a value from the database.
     * @param {TKey} key - The key to retrieve
     * @returns {Promise<TValue | undefined>}
     */
    async get(key) {
        try {
            const value = await this.sublevel.get(key);
            return value;
        } catch (err) {
            // LevelDB throws for missing keys, we return undefined
            const error = /** @type {Error} */ (err);
            if (error.message?.includes('not found') || error.message?.includes('NotFound')) {
                return undefined;
            }
            throw err;
        }
    }

    /**
     * Store a value in the database.
     * @param {TKey} key - The key to store
     * @param {TValue} value - The value to store
     * @returns {Promise<void>}
     */
    async put(key, value) {
        await this.sublevel.put(key, value);
    }

    /**
     * Delete a value from the database.
     * @param {TKey} key - The key to delete
     * @returns {Promise<void>}
     */
    async del(key) {
        await this.sublevel.del(key);
    }

    /**
     * Create a put operation for batch processing.
     * @param {TKey} key - The key to store
     * @param {TValue} value - The value to store
     * @returns {{ db: SimpleSublevel<TKey, TValue>, op: 'put', key: TKey, value: TValue }}
     */
    putOp(key, value) {
        return { db: this.sublevel, op: 'put', key, value };
    }

    /**
     * Create a delete operation for batch processing.
     * @param {TKey} key - The key to delete
     * @returns {{ db: SimpleSublevel<TKey, TValue>, op: 'del', key: TKey }}
     */
    delOp(key) {
        return { db: this.sublevel, op: 'del', key };
    }

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
 * @template K
 * @template V
 * @typedef {import('./types').SimpleSublevel<K, V>} SimpleSublevel
 */

/**
 * Factory function to create a TypedDatabase instance.
 * @template TValue
 * @param {SimpleSublevel<string, TValue>} sublevel - The LevelDB sublevel instance
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
