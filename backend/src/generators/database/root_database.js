/**
 * RootDatabase module.
 * Provides schema-namespaced storage using LevelDB sublevels.
 */

const { makeTypedDatabase } = require('./typed_database');

/** @typedef {import('./types').DatabaseValue} DatabaseValue */
/** @typedef {import('./types').Freshness} Freshness */
/**
 * @template T
 * @typedef {import('./typed_database').GenericDatabase<T>} GenericDatabase
 */

/**
 * Database for storing node output values.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: the computed value (object with type field)
 * @typedef {GenericDatabase<DatabaseValue>} ValuesDatabase
 */

/**
 * Database for storing node freshness state.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: freshness state ('up-to-date' | 'potentially-outdated')
 * @typedef {GenericDatabase<Freshness>} FreshnessDatabase
 */

/**
 * A record storing the input dependencies of a node.
 * @typedef {object} InputsRecord
 * @property {string[]} inputs - Array of canonical input node names
 */

/**
 * Database for storing node input dependencies.
 * Key: canonical node name
 * Value: inputs record with array of dependency names
 * @typedef {GenericDatabase<InputsRecord>} InputsDatabase
 */

/**
 * Database for reverse dependency index using structured values.
 * Key: inputNode (canonical name)
 * Value: Array of dependent node names
 * This avoids composite keys and string prefix logic.
 * @typedef {GenericDatabase<string[]>} RevdepsDatabase
 */

/**
 * Storage container for a single dependency graph schema.
 * All data (values, freshness, indices) is isolated per schema hash.
 * @typedef {object} SchemaStorage
 * @property {ValuesDatabase} values - Node output values
 * @property {FreshnessDatabase} freshness - Node freshness state
 * @property {InputsDatabase} inputs - Node inputs index
 * @property {RevdepsDatabase} revdeps - Reverse dependencies (input -> array of dependents)
 */

/**
 * @template K
 * @template V
 * @typedef {import('./types').SimpleSublevel<K, V>} SimpleSublevel
 */

/**
 * Root database class providing schema-namespaced storage.
 */
class RootDatabaseClass {
    /**
     * The underlying Level database instance.
     * @private
     * @type {import('level').Level<string, unknown>}
     */
    db;

    /**
     * Cache of schema storages.
     * @private
     * @type {Map<string, SchemaStorage>}
     */
    schemaStorages;

    /**
     * @constructor
     * @param {import('level').Level<string, any>} db - The Level database instance
     */
    constructor(db) {
        this.db = db;
        this.schemaStorages = new Map();
    }

    /**
     * Get schema-specific storage (creates if needed).
     * @param {string} schemaHash - The schema hash
     * @returns {SchemaStorage}
     */
    getSchemaStorage(schemaHash) {
        // Check cache first
        const cached = this.schemaStorages.get(schemaHash);
        if (cached) {
            return cached;
        }

        // Create new schema storage with sublevels
        const schemaSublevel = this.db.sublevel(schemaHash, { valueEncoding: 'json' });
        
        /** @type {SimpleSublevel<string, DatabaseValue>} */
        const valuesSublevel = schemaSublevel.sublevel('values', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<string, Freshness>} */
        const freshnessSublevel = schemaSublevel.sublevel('freshness', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<string, InputsRecord>} */
        const inputsSublevel = schemaSublevel.sublevel('inputs', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<string, string[]>} */
        const revdepsSublevel = schemaSublevel.sublevel('revdeps', { valueEncoding: 'json' });

        const storage = {
            values: makeTypedDatabase(valuesSublevel),
            freshness: makeTypedDatabase(freshnessSublevel),
            inputs: makeTypedDatabase(inputsSublevel),
            revdeps: makeTypedDatabase(revdepsSublevel),
        };

        // Cache for future use
        this.schemaStorages.set(schemaHash, storage);

        return storage;
    }

    /**
     * List all schema hashes in the database.
     * @returns {AsyncIterable<string>}
     */
    async *listSchemas() {
        for await (const key of this.db.keys()) {
            yield key;
        }
    }

    /**
     * Close the database connection.
     * @returns {Promise<void>}
     */
    async close() {
        await this.db.close();
    }

    /**
     * Backward compatibility: list keys with prefix.
     * This is provided for test compatibility only.
     * @param {string} prefix - The prefix
     * @returns {Promise<string[]>}
     */
    async keys(prefix = '') {
        const keys = [];
        for await (const key of this.db.keys({
            gte: prefix,
            lt: prefix + '\xFF',
        })) {
            keys.push(key);
        }
        return keys;
    }

    /**
     * Backward compatibility: batch operations.
     * This is provided for test compatibility only.
     * @param {Array<{type: 'put' | 'del', key: string, value?: any}>} operations
     * @returns {Promise<void>}
     */
    async batch(operations) {
        // @ts-expect-error - batch operations are correctly typed at runtime
        await this.db.batch(operations);
    }
}

const { Level } = require('level');

/**
 * Factory function to create a RootDatabase instance.
 * @param {string} databasePath - Path to the database directory
 * @returns {Promise<RootDatabaseClass>}
 */
async function makeRootDatabase(databasePath) {
    const db = new Level(databasePath, { valueEncoding: 'json' });
    await db.open();
    return new RootDatabaseClass(db);
}

/**
 * Type guard for RootDatabase.
 * @param {unknown} object
 * @returns {object is RootDatabaseClass}
 */
function isRootDatabase(object) {
    return object instanceof RootDatabaseClass;
}

/** @typedef {RootDatabaseClass} RootDatabase */

module.exports = {
    makeRootDatabase,
    isRootDatabase,
};
