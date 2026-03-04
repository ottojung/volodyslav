/**
 * RootDatabase module.
 * Provides namespace-bound storage using LevelDB sublevels.
 * Each RootDatabase instance is bound to a single namespace ("x" or "y").
 */

const { getVersion } = require('../../../version');
const { makeTypedDatabase } = require('./typed_database');
const { stringToVersion } = require('./types');

/** @typedef {import('./types').RootLevelType} RootLevelType */
/** @typedef {import('./types').SchemaSublevelType} SchemaSublevelType */
/** @typedef {import('./types').SublevelFormat} SublevelFormat */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').Counter} Counter */
/** @typedef {import('./types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import('./types').DatabaseKey} DatabaseKey */
/** @typedef {import('./types').DatabaseStoredValue} DatabaseStoredValue */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').Version} Version */

/**
 * Sublevel for storing plain-string namespace metadata (e.g., version).
 * Uses string keys rather than NodeKeyString to clearly distinguish meta keys from node keys.
 * @typedef {import('abstract-level').AbstractSublevel<SchemaSublevelType, SublevelFormat, 'version', Version>} MetaSublevelType
 */

/**
 * The format marker value that identifies a database using the x/y namespace layout.
 */
const FORMAT_MARKER = 'xy-v1';

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
 * Storage container for a single incremental graph namespace.
 * All data (values, freshness, indices) is isolated per namespace.
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
 * Root database class bound to a specific namespace (e.g., "x" or "y").
 */
class RootDatabaseClass {
    /**
     * The underlying Level database instance.
     * @private
     * @type {RootLevelType}
     */
    db;

    /**
     * The namespace sublevel — all data lives under this prefix.
     * @private
     * @type {SchemaSublevelType}
     */
    namespaceSublevel;

    /**
     * The meta sublevel for storing namespace metadata (e.g., version).
     * Uses plain string keys to distinguish it from node-data sublevels.
     * @private
     * @type {MetaSublevelType}
     */
    metaSublevel;

    /**
     * Cached schema storage for this namespace.
     * @private
     * @type {SchemaStorage}
     */
    _schemaStorage;

    /**
     * @constructor
     * @param {RootLevelType} db - The Level database instance
     * @param {string} namespace - The namespace ("x" or "y")
     * @param {Version} version - The current application version
     */
    constructor(db, namespace, version) {
        this.db = db;
        this.version = version;

        this.namespaceSublevel = db.sublevel(namespace, { valueEncoding: 'json' });

        /** @type {SimpleSublevel<ComputedValue>} */
        const valuesSublevel = this.namespaceSublevel.sublevel('values', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<Freshness>} */
        const freshnessSublevel = this.namespaceSublevel.sublevel('freshness', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<InputsRecord>} */
        const inputsSublevel = this.namespaceSublevel.sublevel('inputs', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<NodeKeyString[]>} */
        const revdepsSublevel = this.namespaceSublevel.sublevel('revdeps', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<Counter>} */
        const countersSublevel = this.namespaceSublevel.sublevel('counters', { valueEncoding: 'json' });

        this.metaSublevel = this.namespaceSublevel.sublevel('meta', { valueEncoding: 'json' });

        const namespaceSublevel = this.namespaceSublevel;

        let touchedSchema = false;

        /** @type {(operations: DatabaseBatchOperation[]) => Promise<void>} */
        const batch = async (operations) => {
            if (operations.length === 0) {
                return;
            }
            if (!touchedSchema) {
                const existing = await this.getMetaVersion();
                if (existing === undefined) {
                    // New namespace, write version to meta to initialize.
                    await this.setMetaVersion(this.version);
                } else if (existing !== this.version) {
                    // Version mismatch indicates a logic error in migration or usage of staging namespace.
                    throw new Error(`Version mismatch in batch operation: expected ${this.version}, found ${existing}`);
                }
                touchedSchema = true;
            }
            await namespaceSublevel.batch(operations);
        };

        this._schemaStorage = {
            batch,
            values: makeTypedDatabase(valuesSublevel),
            freshness: makeTypedDatabase(freshnessSublevel),
            inputs: makeTypedDatabase(inputsSublevel),
            revdeps: makeTypedDatabase(revdepsSublevel),
            counters: makeTypedDatabase(countersSublevel),
        };
    }

    /**
     * Get storage scoped to this namespace.
     * @returns {SchemaStorage}
     */
    getSchemaStorage() {
        return this._schemaStorage;
    }

    /**
     * Get the app version string stored in this namespace's meta sublevel.
     * Returns undefined if no version has been recorded yet (fresh database).
     * @returns {Promise<Version | undefined>}
     */
    async getMetaVersion() {
        return await this.metaSublevel.get('version');
    }

    /**
     * Write the app version string into this namespace's meta sublevel.
     * @param {Version} version
     * @returns {Promise<void>}
     */
    async setMetaVersion(version) {
        await this.metaSublevel.put('version', version);
    }

    /**
     * Create a new RootDatabase bound to a different namespace using the same underlying DB.
     * Used by migration to open the staging ("y") namespace alongside the live ("x") namespace.
     * @param {string} namespace
     * @returns {RootDatabaseClass}
     */
    withNamespace(namespace) {
        return new RootDatabaseClass(this.db, namespace, this.version);
    }

    /**
     * Clear all keys in this namespace (values, freshness, inputs, revdeps, counters, meta).
     * @returns {Promise<void>}
     */
    async clearStorage() {
        await this.namespaceSublevel.clear();
    }

    /**
     * Atomically replace this namespace's data with all data from sourceDb's namespace,
     * then clear sourceDb's namespace. The caller is responsible for writing any metadata
     * (e.g., version) into sourceDb's namespace BEFORE calling this method so that it
     * is included in the copy.
     *
     * Steps performed in a single LevelDB batch:
     *   1. Delete all keys under this namespace.
     *   2. Copy all key/value pairs from sourceDb's namespace into this namespace.
     *   3. Delete all keys under sourceDb's namespace.
     * @param {RootDatabaseClass} sourceDb - The source namespace database (e.g., "y")
     * @returns {Promise<void>}
     */
    async replaceContentsFrom(sourceDb) {
        /** @type {Array<{type: 'put', key: DatabaseKey, value: DatabaseStoredValue, sublevel: SchemaSublevelType} | {type: 'del', key: DatabaseKey, sublevel: SchemaSublevelType}>} */
        const ops = [];

        // 1. Delete all keys in this namespace
        for await (const key of this.namespaceSublevel.keys()) {
            ops.push({ type: 'del', key, sublevel: this.namespaceSublevel });
        }

        // 2. Copy all entries from sourceDb namespace into this namespace,
        //    and queue deletion of those entries from sourceDb namespace.
        for await (const [key, value] of sourceDb.namespaceSublevel.iterator()) {
            ops.push({ type: 'put', key, value, sublevel: this.namespaceSublevel });
            ops.push({ type: 'del', key, sublevel: sourceDb.namespaceSublevel });
        }

        await this.db.batch(ops);
    }

    /**
     * Close the database connection.
     * @returns {Promise<void>}
     */
    async close() {
        await this.db.close();
    }
}


/**
 * @typedef {import('../../../level_database').LevelDatabase} LevelDatabase
 */

/**
 * @typedef {import('../../../subprocess/command').Command} Command
 */

/**
 * @typedef {import('../../../logger').Logger} Logger
 */

/**
 * @typedef {import('../../../filesystem/reader').FileReader} FileReader
 */

/**
 * @typedef {import('../../../filesystem/checker').FileChecker} FileChecker
 */

/**
 * @typedef {object} RootDatabaseCapabilities
 * @property {LevelDatabase} levelDatabase - The Level database capability
 * @property {Command} git - A command instance for Git operations.
 * @property {Logger} logger - A logger instance.
 * @property {FileReader} reader - A file reader instance.
 * @property {FileChecker} checker - A file checker instance.
 */

/**
 * Factory function to create a RootDatabase instance bound to the live ("x") namespace.
 * On first open (no format marker present), writes the format marker to initialise a fresh
 * database.  If a format marker exists but does not match, the database is from an
 * incompatible layout and an Error is thrown — the caller should delete the database
 * directory and start fresh.
 * @param {RootDatabaseCapabilities} capabilities - The capabilities required to create the database
 * @param {string} databasePath - Path to the database directory
 * @returns {Promise<RootDatabaseClass>}
 */
async function makeRootDatabase(capabilities, databasePath) {
    const version = stringToVersion(await getVersion(capabilities));
    /** @type {RootLevelType} */
    const db = capabilities.levelDatabase.initialize(databasePath);
    await db.open();

    // Check the root-level format marker to ensure we are using the x/y namespace layout.
    const rootMetaSublevel = db.sublevel('_meta', { valueEncoding: 'json' });
    const formatMarker = await rootMetaSublevel.get('format');
    if (formatMarker === undefined) {
        // Fresh database: write the format marker to initialise.
        await rootMetaSublevel.put('format', FORMAT_MARKER);
    } else if (formatMarker !== FORMAT_MARKER) {
        // Existing database with an incompatible format — refuse to open.
        await db.close();
        throw new Error(`Database format marker mismatch: expected "${FORMAT_MARKER}", found "${formatMarker}". This may indicate an old database layout or a corrupted database. Please ensure the database is correct or delete it to start fresh.`);
    }

    return new RootDatabaseClass(db, 'x', version);
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
