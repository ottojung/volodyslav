/**
 * Typed database abstraction layer.
 * Provides a GenericDatabase interface that wraps LevelDB sublevels with strong typing.
 */

/** @typedef {import('./types').SchemaSublevelType} SchemaSublevelType */

/**
 * @template T
 * @template [K=import('./types').DatabaseKey]
 * @typedef {import('./types').SimpleSublevel<T, K>} SimpleSublevel
 */

/**
 * @template T
 * @template [K=import('./types').DatabaseKey]
 * @typedef {{ type: 'put', sublevel: SimpleSublevel<T, K>, key: K, value: T }} DatabasePutOperation
 */

/**
 * @template T
 * @template [K=import('./types').DatabaseKey]
 * @typedef {{ type: 'del', sublevel: SimpleSublevel<T, K>, key: K }} DatabaseDelOperation
 */

/**
 * @typedef {import('./types').DatabaseKey} DatabaseKey
 */

/**
 * Generic typed database interface.
 * All databases (values, freshness, inputs, revdeps) implement this interface.
 * @template TValue - The value type
 * @template TKey - The key type
 * @typedef {object} GenericDatabase
 * @property {(key: TKey) => Promise<TValue | undefined>} get - Retrieve a value
 * @property {(key: TKey, value: TValue) => Promise<void>} put - Store a value
 * @property {(key: TKey, value: *) => Promise<void>} rawPut - Store a value with sync:false (for unification adapters where runtime type is guaranteed by schema invariant)
 * @property {(key: TKey) => Promise<void>} del - Delete a value
 * @property {(key: TKey) => Promise<void>} rawDel - Delete a value with sync:false (for unification adapters; mirrors rawPut)
 * @property {(key: TKey, value: TValue) => DatabasePutOperation<TValue, TKey>} putOp - Store a value operation
 * @property {(key: TKey, value: *) => DatabasePutOperation<TValue, TKey>} rawPutOp - Store a value operation accepting an untyped value (for unification adapters where runtime type is guaranteed by schema invariant)
 * @property {(key: TKey) => DatabaseDelOperation<TValue, TKey>} delOp - Delete a value operation
 * @property {() => AsyncIterable<TKey>} keys - Iterate over all keys
 * @property {() => Promise<void>} clear - Clear all entries
 */

/**
 * Wrapper class that adapts a LevelDB sublevel to the GenericDatabase interface.
 * @template TValue
 * @template TKey
 */
class TypedDatabaseClass {
    /**
     * The underlying LevelDB sublevel instance.
     * @private
     * @type {SimpleSublevel<TValue, TKey>}
     */
    sublevel;

    /**
     * @constructor
     * @param {SimpleSublevel<TValue, TKey>} sublevel - The LevelDB sublevel instance
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
     * @param {TKey} key - The key to retrieve
     * @returns {Promise<TValue | undefined>}
     */
    async get(key) {
        return this.sublevel.get(key);
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
     * Store a value in the database, accepting an untyped value, using sync:false.
     * For use only in unification adapters where values originate from the same
     * schema and are therefore the correct runtime type despite being typed as
     * unknown at the call site.  Keeping this separate from put preserves
     * the typed boundary for normal callers.
     *
     * sync:false means the OS may buffer the write before flushing to disk.
     * Callers must invoke rootDatabase._rawSync() once after all unification
     * writes are complete to ensure durability.
     * @param {TKey} key - The key to store
     * @param {*} value - The value to store (must be TValue at runtime)
     * @returns {Promise<void>}
     */
    async rawPut(key, value) {
        // Pass sync:false to avoid per-write fsyncs during bulk unification.
        // classic-level supports sync at runtime; abstract-level's type for
        // AbstractPutOptions is a "weak type" (all-optional properties) so
        // TypeScript requires at least one recognised property to be present.
        // keyEncoding:undefined is a valid AbstractPutOptions property (means
        // "use default encoding") and satisfies the weak-type check without
        // changing runtime behaviour.
        const opts = { sync: false, keyEncoding: undefined };
        await this.sublevel.put(key, value, opts);
    }

    /**
     * Delete a value from the database using sync:false.
     * Mirrors rawPut(): for use only in unification adapters.
     * Callers must invoke rootDatabase._rawSync() once after all unification
     * writes are complete to ensure durability.
     * @param {TKey} key - The key to delete
     * @returns {Promise<void>}
     */
    async rawDel(key) {
        // Pass sync:false to avoid per-write fsyncs during bulk unification.
        // See rawPut() for the keyEncoding:undefined weak-type-check workaround.
        const opts = { sync: false, keyEncoding: undefined };
        await this.sublevel.del(key, opts);
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
     * @returns {DatabasePutOperation<TValue, TKey>}
     */
    putOp(key, value) {
        return { sublevel: this.sublevel, type: "put", key, value };
    }

    /**
     * Create a put operation for batch processing, accepting an untyped value.
     * For use only in unification adapters where values originate from the same
     * schema and are therefore the correct runtime type despite being typed as
     * unknown at the call site.  Keeping this separate from putOp preserves
     * the typed boundary for normal callers.
     * @param {TKey} key - The key to store
     * @param {*} value - The value to store (must be TValue at runtime)
     * @returns {DatabasePutOperation<TValue, TKey>}
     */
    rawPutOp(key, value) {
        return { sublevel: this.sublevel, type: "put", key, value };
    }

    /**
     * Create a delete operation for batch processing.
     * @param {TKey} key - The key to delete
     * @returns {DatabaseDelOperation<TValue, TKey>}
     */
    delOp(key) {
        /** @type {SimpleSublevel<TValue, TKey>} */
        const thisSublevel = this.sublevel;
        /** @type {SimpleSublevel<TValue, TKey>} */
        const sublevel = thisSublevel;
        return { sublevel: sublevel, type: "del", key };
    }

    /**
     * Iterate over all keys in the database.
     * @returns {AsyncIterable<TKey>}
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
 * @template TKey
 * @param {SimpleSublevel<TValue, TKey>} sublevel - The LevelDB sublevel instance
 * @returns {GenericDatabase<TValue, TKey>}
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
