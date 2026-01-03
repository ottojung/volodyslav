/**
 * RootDatabase module.
 * Provides schema-namespaced storage using LevelDB sublevels.
 */

const { makeTypedDatabase } = require('./typed_database');

/** @typedef {import('./types').RootLevelType} RootLevelType */
/** @typedef {import('./types').SchemaSublevelType} SchemaSublevelType */
/** @typedef {import('./types').DatabaseValue} DatabaseValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').DatabaseStoredValue} DatabaseStoredValue */
/**
 * @typedef {import('./types').DatabaseBatchOperation} DatabaseBatchOperation
 */

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
 * @template T
 * @typedef {import('./types').SimpleSublevel<T>} SimpleSublevel
 */

/**
 * Root database class providing schema-namespaced storage.
 */
class RootDatabaseClass {
    /**
     * The underlying Level database instance.
     * @private
     * @type {RootLevelType}
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
     * @param {RootLevelType} db - The Level database instance
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
        /** @type {SchemaSublevelType} */
        const schemaSublevel = this.db.sublevel(schemaHash, { valueEncoding: 'json' });
        
        /** @type {SimpleSublevel<DatabaseValue>} */
        const valuesSublevel = schemaSublevel.sublevel('values', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<Freshness>} */
        const freshnessSublevel = schemaSublevel.sublevel('freshness', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<InputsRecord>} */
        const inputsSublevel = schemaSublevel.sublevel('inputs', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<string[]>} */
        const revdepsSublevel = schemaSublevel.sublevel('revdeps', { valueEncoding: 'json' });

        const storage = {
            values: makeTypedDatabase(schemaSublevel, valuesSublevel),
            freshness: makeTypedDatabase(schemaSublevel, freshnessSublevel),
            inputs: makeTypedDatabase(schemaSublevel, inputsSublevel),
            revdeps: makeTypedDatabase(schemaSublevel, revdepsSublevel),
        };

        // Cache for future use
        this.schemaStorages.set(schemaHash, storage);

        return storage;
    }

    /**
     * Perform a batch operation across multiple sublevels.
     * @param {Array<DatabaseBatchOperation>} operations
     * @returns {Promise<void>}
     */
    async batch(operations) {
        return this.db.batch(operations, { sync: true });
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
}

const { Level } = require('level');

/**
 * Factory function to create a RootDatabase instance.
 * @param {string} databasePath - Path to the database directory
 * @returns {Promise<RootDatabaseClass>}
 */
async function makeRootDatabase(databasePath) {
    /** @type {RootLevelType} */
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
