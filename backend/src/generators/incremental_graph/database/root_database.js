/**
 * RootDatabase module.
 * Provides schema-namespaced storage using LevelDB sublevels.
 */

const { makeTypedDatabase } = require('./typed_database');

/** @typedef {import('./types').RootLevelType} RootLevelType */
/** @typedef {import('./types').SchemaSublevelType} SchemaSublevelType */
/** @typedef {import('./types').ListOfSchemasType} ListOfSchemasType */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').Counter} Counter */
/** @typedef {import('./types').DatabaseStoredValue} DatabaseStoredValue */
/** @typedef {import('./types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import('./types').SchemaHash} SchemaHash */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */

/**
 * @template T
 * @typedef {import('./typed_database').GenericDatabase<T>} GenericDatabase
 */

/**
 * Database for storing node output values.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: the computed value (object with type field)
 * @typedef {GenericDatabase<ComputedValue>} ValuesDatabase
 */

/**
 * Database for storing node freshness state.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: freshness state ('up-to-date' | 'potentially-outdated')
 * @typedef {GenericDatabase<Freshness>} FreshnessDatabase
 */

/**
 * A record storing the input dependencies of a node and their counters.
 * @typedef {object} InputsRecord
 * @property {string[]} inputs - Array of canonical input node names
 * @property {number[]} inputCounters - Array of counter values for each input (required when inputs.length > 0)
 */

/**
 * Database for storing node input dependencies.
 * Key: canonical node name
 * Value: inputs record with array of dependency names
 * @typedef {GenericDatabase<InputsRecord>} InputsDatabase
 */

/**
 * Database for reverse dependency index.
 * Key: canonical input node name
 * Value: array of canonical dependent node names
 * @typedef {GenericDatabase<NodeKeyString[]>} RevdepsDatabase
 */

/**
 * Database for storing node counters.
 * Key: canonical node name
 * Value: counter (monotonic integer tracking value changes)
 * @typedef {GenericDatabase<Counter>} CountersDatabase
 */

/**
 * Storage container for a single incremental graph schema.
 * All data (values, freshness, indices) is isolated per schema hash.
 * @typedef {object} SchemaStorage
 * @property {ValuesDatabase} values - Node output values
 * @property {FreshnessDatabase} freshness - Node freshness state
 * @property {InputsDatabase} inputs - Node inputs index
 * @property {RevdepsDatabase} revdeps - Reverse dependencies (input node -> array of dependents)
 * @property {CountersDatabase} counters - Node counters (monotonic integers)
 * @property {(operations: DatabaseBatchOperation[]) => Promise<void>} batch - Batch operation interface for atomic writes
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
     * @type {Map<SchemaHash, SchemaStorage>}
     */
    schemaStorages;

    /**
     * The sublevel for listing all schemas.
     * @private
     * @type {ListOfSchemasType}
     */
    listOfSchemas;

    /**
     * @constructor
     * @param {RootLevelType} db - The Level database instance
     */
    constructor(db) {
        this.db = db;
        this.schemaStorages = new Map();
        this.listOfSchemas = this.db.sublevel('schemas', { valueEncoding: 'json' });
    }

    /**
     * Get schema-specific storage (creates if needed).
     * @param {SchemaHash} schemaHash - The schema hash
     * @returns {SchemaStorage}
     */
    getSchemaStorage(schemaHash) {
        // Check cache first
        const schemaHashStr = schemaHashToString(schemaHash);
        const cached = this.schemaStorages.get(schemaHash);
        if (cached) {
            return cached;
        }

        // Create new schema storage with sublevels
        /** @type {SchemaSublevelType} */
        const schemaSublevel = this.db.sublevel(schemaHashStr, { valueEncoding: 'json' });

        /** @type {SimpleSublevel<ComputedValue>} */
        const valuesSublevel = schemaSublevel.sublevel('values', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<Freshness>} */
        const freshnessSublevel = schemaSublevel.sublevel('freshness', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<InputsRecord>} */
        const inputsSublevel = schemaSublevel.sublevel('inputs', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<NodeKeyString[]>} */
        const revdepsSublevel = schemaSublevel.sublevel('revdeps', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<Counter>} */
        const countersSublevel = schemaSublevel.sublevel('counters', { valueEncoding: 'json' });

        let touchedSchema = false;
        /** @type {(operations: DatabaseBatchOperation[]) => Promise<void>} */
        const batch = async (operations) => {
            if (operations.length === 0) {
                return;
            }

            if (!touchedSchema) {
                await this.listOfSchemas.put(schemaHash, 1); // Touch schema key with constant value
                touchedSchema = true;
            }
            await schemaSublevel.batch(operations);
        };

        const storage = {
            batch,
            values: makeTypedDatabase(valuesSublevel),
            freshness: makeTypedDatabase(freshnessSublevel),
            inputs: makeTypedDatabase(inputsSublevel),
            revdeps: makeTypedDatabase(revdepsSublevel),
            counters: makeTypedDatabase(countersSublevel),
        };

        // Cache for future use
        this.schemaStorages.set(schemaHash, storage);

        return storage;
    }

    /**
     * List all stored schema hashes.
     * @returns {AsyncIterable<SchemaHash>}
     */
    async *listSchemas() {
        for await (const key of this.listOfSchemas.keys()) {
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
const { schemaHashToString } = require('./types');

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
