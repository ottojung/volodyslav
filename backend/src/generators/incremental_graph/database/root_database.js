/**
 * RootDatabase module.
 * Provides replica-pointer-aware storage using LevelDB sublevels.
 * Each RootDatabase instance tracks the active replica via `_meta/current_replica`.
 */

const { getVersion } = require('../../../version');
const { makeTypedDatabase } = require('./typed_database');
const { stringToVersion, stringToNodeKeyString, versionToString } = require('./types');
const { RAW_BATCH_CHUNK_SIZE } = require('./constants');
const {
    hostnameSchemaStorage: hostnameSchemaStorageHelper,
    clearHostnameStorage: clearHostnameStorageHelper,
    getHostnameMetaVersion: getHostnameMetaVersionHelper,
    setHostnameMeta: setHostnameMetaHelper,
    rawPutAllToHostname: rawPutAllToHostnameHelper,
} = require('./hostname_storage');
const {
    InvalidReplicaPointerError,
    isInvalidReplicaPointerError,
    SwitchReplicaError,
    isSwitchReplicaError,
    SchemaBatchVersionError,
    isSchemaBatchVersionError,
} = require('./replica_errors');

/** @typedef {import('./types').RootLevelType} RootLevelType */
/** @typedef {import('./types').SchemaSublevelType} SchemaSublevelType */
/** @typedef {import('./types').SublevelFormat} SublevelFormat */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').Counter} Counter */
/** @typedef {import('./types').TimestampRecord} TimestampRecord */
/** @typedef {import('./types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import('./types').DatabaseKey} DatabaseKey */
/** @typedef {import('./types').DatabaseStoredValue} DatabaseStoredValue */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').Version} Version */

/**
 * Common base type for any abstract-level database instance at any nesting depth.
 * Both `Level<K, V>` and `AbstractSublevel<Parent, F, K, V>` extend this base,
 * so it can represent both the root database and any nested sublevel.
 * Used as a looser parameter type for internal helpers that only need the shared
 * abstract-level API (sublevel(), batch(), etc.).
 * @typedef {import('abstract-level').AbstractLevel<SublevelFormat, NodeKeyString, DatabaseStoredValue>} AnyLevelType
 */

/**
 * Sublevel for storing plain-string namespace metadata (e.g., version).
 * Uses string keys rather than NodeKeyString to clearly distinguish meta keys from node keys.
 * @typedef {import('abstract-level').AbstractSublevel<SchemaSublevelType, SublevelFormat, 'version', Version>} MetaSublevelType
 */

/**
 * The format marker value that identifies a database using the x/y namespace layout.
 */
const FORMAT_MARKER = 'xy-v2';

/**
 * The valid replica names.
 * @typedef {'x' | 'y'} ReplicaName
 */

/**
 * Asserts that a value is `never` at the type level.
 * Used in exhaustive switch/if-else chains to enforce compile-time completeness.
 * Also throws `InvalidReplicaPointerError` at runtime as a defensive guard.
 * @param {never} name - The value that should be unreachable.
 * @returns {never}
 */
function assertNeverReplicaName(name) {
    throw new InvalidReplicaPointerError(name);
}

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
 * Database for storing node timestamps (creation and modification times).
 * Key: canonical node name
 * Value: timestamp record with createdAt and modifiedAt ISO strings
 * @typedef {GenericDatabase<TimestampRecord>} TimestampsDatabase
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
 * @property {TimestampsDatabase} timestamps - Node timestamps (creation and modification)
 * @property {(operations: DatabaseBatchOperation[]) => Promise<void>} batch - Batch operation interface for atomic writes
 */

/**
 * @template T
 * @typedef {import('./types').SimpleSublevel<T>} SimpleSublevel
 */

/**
 * Build a SchemaStorage for one replica namespace.
 * The returned storage's `batch` function verifies the replica's meta/version on
 * the first write (initialising it when absent, or throwing on mismatch), then
 * caches the result so subsequent batches pay no I/O overhead for the check.
 *
 * When the replica is cleared (`clearReplicaStorage`), a fresh SchemaStorage is
 * built by the owner so the version-initialisation cache is reset.
 *
 * @param {SchemaSublevelType} namespaceSublevel - The replica's top-level sublevel.
 * @param {MetaSublevelType} metaSublevel - The replica's meta sublevel (`<ns>/meta`).
 * @param {Version} version - The current application version.
 * @returns {SchemaStorage}
 */
function buildSchemaStorage(namespaceSublevel, metaSublevel, version) {
    /** @type {SimpleSublevel<ComputedValue>} */
    const valuesSublevel = namespaceSublevel.sublevel('values', { valueEncoding: 'json' });
    /** @type {SimpleSublevel<Freshness>} */
    const freshnessSublevel = namespaceSublevel.sublevel('freshness', { valueEncoding: 'json' });
    /** @type {SimpleSublevel<InputsRecord>} */
    const inputsSublevel = namespaceSublevel.sublevel('inputs', { valueEncoding: 'json' });
    /** @type {SimpleSublevel<NodeKeyString[]>} */
    const revdepsSublevel = namespaceSublevel.sublevel('revdeps', { valueEncoding: 'json' });
    /** @type {SimpleSublevel<Counter>} */
    const countersSublevel = namespaceSublevel.sublevel('counters', { valueEncoding: 'json' });
    /** @type {SimpleSublevel<TimestampRecord>} */
    const timestampsSublevel = namespaceSublevel.sublevel('timestamps', { valueEncoding: 'json' });

    // True once this closure's first batch() verifies/writes meta/version.
    // Prevents redundant DB reads on subsequent batch calls.
    // Reset to false by rebuilding this SchemaStorage inside clearReplicaStorage().
    let touchedSchema = false;

    /** @type {(operations: DatabaseBatchOperation[]) => Promise<void>} */
    const batch = async (operations) => {
        if (operations.length === 0) {
            return;
        }
        if (!touchedSchema) {
            const existing = await metaSublevel.get('version');
            if (existing === undefined) {
                // New or freshly-cleared namespace: write version to meta to initialise.
                await metaSublevel.put('version', version);
            } else if (existing !== version) {
                // Version mismatch indicates a logic error in migration or usage of staging namespace.
                throw new SchemaBatchVersionError(versionToString(version), versionToString(existing));
            }
            touchedSchema = true;
        }
        await namespaceSublevel.batch(operations);
    };

    return {
        batch,
        values: makeTypedDatabase(valuesSublevel),
        freshness: makeTypedDatabase(freshnessSublevel),
        inputs: makeTypedDatabase(inputsSublevel),
        revdeps: makeTypedDatabase(revdepsSublevel),
        counters: makeTypedDatabase(countersSublevel),
        timestamps: makeTypedDatabase(timestampsSublevel),
    };
}

/**
 * Root database class with replica-pointer awareness.
 *
 * Maintains a cached `_meta/current_replica` pointer (always "x" or "y") and
 * exposes both schema storages so that migration can write to the inactive
 * replica without touching the active one.
 */
class RootDatabaseClass {
    /**
     * The underlying Level database instance.
     * @private
     * @type {RootLevelType}
     */
    db;

    /**
     * Cached name of the currently active replica ("x" or "y").
     * @private
     * @type {ReplicaName}
     */
    _cachedValueOfCurrentReplica;

    /**
     * Root-level `_meta` sublevel used to persist the replica pointer.
     * @private
     */
    _rootMetaSublevel;

    /**
     * Meta sublevels for each replica (used by getMetaVersion / setMetaVersion).
     * @private
     * @type {MetaSublevelType}
     */
    _xMetaSublevel;

    /**
     * @private
     * @type {MetaSublevelType}
     */
    _yMetaSublevel;

    /**
     * Top-level namespace sublevels for each replica (used by clearReplicaStorage).
     * @private
     * @type {SchemaSublevelType}
     */
    _xNamespaceSublevel;

    /**
     * @private
     * @type {SchemaSublevelType}
     */
    _yNamespaceSublevel;

    /**
     * Pre-built schema storages for each replica.
     * @private
     * @type {SchemaStorage}
     */
    _xSchemaStorage;

    /**
     * @private
     * @type {SchemaStorage}
     */
    _ySchemaStorage;

    /**
     * @constructor
     * @param {RootLevelType} db - The Level database instance
     * @param {Version} version - The current application version
     * @param {ReplicaName} currentReplicaName - The initially active replica ("x" or "y")
     */
    constructor(db, version, currentReplicaName) {
        this.db = db;
        this.version = version;
        this._cachedValueOfCurrentReplica = currentReplicaName;

        // Root-level _meta sublevel for the replica pointer.
        this._rootMetaSublevel = db.sublevel('_meta', { valueEncoding: 'json' });

        // Build per-replica sublevels and schema storages.
        this._xNamespaceSublevel = db.sublevel('x', { valueEncoding: 'json' });
        this._yNamespaceSublevel = db.sublevel('y', { valueEncoding: 'json' });
        this._xMetaSublevel = this._xNamespaceSublevel.sublevel('meta', { valueEncoding: 'json' });
        this._yMetaSublevel = this._yNamespaceSublevel.sublevel('meta', { valueEncoding: 'json' });
        this._xSchemaStorage = buildSchemaStorage(this._xNamespaceSublevel, this._xMetaSublevel, version);
        this._ySchemaStorage = buildSchemaStorage(this._yNamespaceSublevel, this._yMetaSublevel, version);
    }

    /**
     * Get the name of the currently active replica.
     * Synchronous — backed by a cache populated at construction time.
     * @returns {ReplicaName}
     */
    currentReplicaName() {
        return this._cachedValueOfCurrentReplica;
    }

    /**
     * Get the name of the inactive (other) replica.
     * @returns {ReplicaName}
     */
    otherReplicaName() {
        const current = this._cachedValueOfCurrentReplica;
        if (current === 'x') {
            return 'y';
        } else if (current === 'y') {
            return 'x';
        } else {
            return assertNeverReplicaName(current);
        }
    }

    /**
     * Switch the active replica pointer to `name`.
     * Writes the new value to `_meta/current_replica` and updates the cache.
     * Throws `InvalidReplicaPointerError` for unrecognised names.
     * Throws `SwitchReplicaError` if the write fails.
     * @param {ReplicaName} name
     * @returns {Promise<void>}
     */
    async switchToReplica(name) {
        if (name === 'x') {
            // x is valid
        } else if (name === 'y') {
            // y is valid
        } else {
            assertNeverReplicaName(name);
        }
        try {
            await this._rootMetaSublevel.put('current_replica', name);
        } catch (err) {
            throw new SwitchReplicaError(name, err);
        }
        this._cachedValueOfCurrentReplica = name;
    }

    /**
     * Get the SchemaStorage for the currently active replica.
     * Reflects pointer changes made by `switchToReplica`.
     * @returns {SchemaStorage}
     */
    getSchemaStorage() {
        const current = this._cachedValueOfCurrentReplica;
        if (current === 'x') {
            return this._xSchemaStorage;
        } else if (current === 'y') {
            return this._ySchemaStorage;
        } else {
            return assertNeverReplicaName(current);
        }
    }

    /**
     * Get the SchemaStorage for an explicit replica, without changing the active pointer.
     * Used by migration to access both source and target replicas simultaneously.
     * Throws `InvalidReplicaPointerError` for unrecognised names.
     * @param {ReplicaName} name
     * @returns {SchemaStorage}
     */
    schemaStorageForReplica(name) {
        if (name === 'x') {
            return this._xSchemaStorage;
        } else if (name === 'y') {
            return this._ySchemaStorage;
        } else {
            return assertNeverReplicaName(name);
        }
    }

    /**
     * Get the app version string stored in the currently active replica's meta sublevel.
     * Returns undefined if no version has been recorded yet (fresh database).
     * @returns {Promise<Version | undefined>}
     */
    async getMetaVersion() {
        const current = this._cachedValueOfCurrentReplica;
        let metaSublevel;
        if (current === 'x') {
            metaSublevel = this._xMetaSublevel;
        } else if (current === 'y') {
            metaSublevel = this._yMetaSublevel;
        } else {
            return assertNeverReplicaName(current);
        }
        return await metaSublevel.get('version');
    }

    /**
     * Write the app version string into the currently active replica's meta sublevel.
     * @param {Version} version
     * @returns {Promise<void>}
     */
    async setMetaVersion(version) {
        const current = this._cachedValueOfCurrentReplica;
        let metaSublevel;
        if (current === 'x') {
            metaSublevel = this._xMetaSublevel;
        } else if (current === 'y') {
            metaSublevel = this._yMetaSublevel;
        } else {
            return assertNeverReplicaName(current);
        }
        await metaSublevel.put('version', version);
    }

    /**
     * Read the app version string from a specific replica's meta sublevel.
     * Returns `undefined` when no version has been written yet.
     * Throws `InvalidReplicaPointerError` for unrecognised names.
     * @param {ReplicaName} name
     * @returns {Promise<Version | undefined>}
     */
    async getMetaVersionForReplica(name) {
        let metaSublevel;
        if (name === 'x') {
            metaSublevel = this._xMetaSublevel;
        } else if (name === 'y') {
            metaSublevel = this._yMetaSublevel;
        } else {
            return assertNeverReplicaName(name);
        }
        return await metaSublevel.get('version');
    }

    /**
     * Write the app version string into a specific replica's meta sublevel.
     * Used by migration to set the target replica's version before switching the pointer.
     * Throws `InvalidReplicaPointerError` for unrecognised names.
     * @param {ReplicaName} name
     * @param {Version} version
     * @returns {Promise<void>}
     */
    async setMetaVersionForReplica(name, version) {
        let metaSublevel;
        if (name === 'x') {
            metaSublevel = this._xMetaSublevel;
        } else if (name === 'y') {
            metaSublevel = this._yMetaSublevel;
        } else {
            return assertNeverReplicaName(name);
        }
        await metaSublevel.put('version', version);
    }

    /**
     * Clear all keys in a specific replica's namespace sublevel, then rebuild its
     * SchemaStorage so the version-initialisation state is reset.
     * The `schemaStorageForReplica` call immediately after this method will return
     * the freshly built storage; any reference obtained before this call is stale
     * and must be discarded.
     * Throws `InvalidReplicaPointerError` for unrecognised names.
     * @param {ReplicaName} name
     * @returns {Promise<void>}
     */
    async clearReplicaStorage(name) {
        if (name === 'x') {
            await this._xNamespaceSublevel.clear();
            // Rebuild to reset the version-initialisation cache in the new closure.
            this._xSchemaStorage = buildSchemaStorage(this._xNamespaceSublevel, this._xMetaSublevel, this.version);
        } else if (name === 'y') {
            await this._yNamespaceSublevel.clear();
            // Rebuild to reset the version-initialisation cache in the new closure.
            this._ySchemaStorage = buildSchemaStorage(this._yNamespaceSublevel, this._yMetaSublevel, this.version);
        } else {
            return assertNeverReplicaName(name);
        }
    }

    /**
     * Returns a bare SchemaStorage for a hostname staging namespace.
     * @param {string} hostname - The hostname key (must be non-empty and must not
     *   contain `/`, `\`, or `!`).
     * @returns {SchemaStorage}
     * @throws {import('./hostname_storage').InvalidHostnameError} If the hostname is invalid.
     */
    hostnameSchemaStorage(hostname) {
        return hostnameSchemaStorageHelper(this.db, hostname);
    }

    /**
     * Clear all data stored under the `_h_<hostname>` staging namespace.
     * @param {string} hostname - The hostname key (must be non-empty and must not
     *   contain `/`, `\`, or `!`).
     * @returns {Promise<void>}
     * @throws {import('./hostname_storage').InvalidHostnameError} If the hostname is invalid.
     */
    async clearHostnameStorage(hostname) {
        return clearHostnameStorageHelper(this.db, hostname);
    }

    /**
     * Reads the app version stored in a hostname's staging meta sublevel.
     * Returns `undefined` when the hostname storage contains no version entry.
     * @param {string} hostname
     * @returns {Promise<Version | undefined>}
     */
    async getHostnameMetaVersion(hostname) {
        return getHostnameMetaVersionHelper(this.db, hostname);
    }

    /**
     * Write a meta key/value pair into a hostname's staging meta sublevel.
     * @param {string} hostname
     * @param {string} key - The meta key to write (e.g. 'version').
     * @param {*} value - The value to store.
     * @returns {Promise<void>}
     */
    async setHostnameMeta(hostname, key, value) {
        return setHostnameMetaHelper(this.db, hostname, key, value);
    }

    /**
     * Write raw `{ sublevelName, subkey, value }` entries into a hostname's
     * staging namespace without going through the typed schema layer.
     * @param {string} hostname
     * @param {Array<{ sublevelName: string, subkey: string, value: * }>} entries
     * @returns {Promise<void>}
     */
    async _rawPutAllToHostname(hostname, entries) {
        return rawPutAllToHostnameHelper(this.db, hostname, entries);
    }

    /**
     * This is equivalent to iterating every key with the `!<sublevelName>!` prefix
     * and deleting them, but delegates to abstract-level's `sublevel.clear()` so
     * the operation is handled in a single efficient range-delete rather than a
     * chunked batch.
     *
     * @param {string} sublevelName - Top-level sublevel name (e.g. "x", "_meta").
     * @returns {Promise<void>}
     */
    async _rawDeleteSublevel(sublevelName) {
        /** @type {SchemaSublevelType} */
        const sublevel = this.db.sublevel(sublevelName, { valueEncoding: 'json' });
        await sublevel.clear();
    }

    /**
     * Iterates over all raw key/value pairs belonging to one top-level LevelDB
     * sublevel.  Unlike `_rawEntries()`, this method only reads the requested
     * sublevel (via abstract-level's built-in range scoping) instead of scanning
     * the entire database and filtering by prefix.
     *
     * Each yielded key is the full root-level key (e.g. `!x!!values!...` or
     * `!_meta!format`) reconstructed by prepending `!<sublevelName>!` to the
     * key returned by the sublevel iterator.
     *
     * @param {string} sublevelName - Top-level sublevel name (e.g. "x", "_meta").
     * @returns {AsyncIterable<[string, unknown]>}
     */
    async *_rawEntriesForSublevel(sublevelName) {
        /** @type {SchemaSublevelType} */
        const sublevel = this.db.sublevel(sublevelName, { valueEncoding: 'json' });
        const rawKeyPrefix = `!${sublevelName}!`;
        for await (const [key, value] of sublevel.iterator()) {
            yield [rawKeyPrefix + key, value];
        }
    }

    /**
     * Read a single raw value from a named sublevel by its inner key.
     * The innerKey is the portion of the raw LevelDB key after the
     * "!{sublevelName}!" prefix.  Returns undefined if not found.
     *
     * @param {string} sublevelName - Top-level sublevel name (e.g. "x", "_meta").
     * @param {string} innerKey - Key within the sublevel.
     * @returns {Promise<unknown>}
     */
    async _rawGetInSublevel(sublevelName, innerKey) {
        /** @type {SchemaSublevelType} */
        const sublevel = this.db.sublevel(sublevelName, { valueEncoding: 'json' });
        return await sublevel.get(stringToNodeKeyString(innerKey));
    }

    /**
     * Iterate over all raw key/value pairs in the root LevelDB instance.
     * Yields every entry stored at the root level, including all sublevel-prefixed keys.
     * Used by renderToFilesystem to produce a complete snapshot.
     * @returns {AsyncIterable<[string, unknown]>}
     */
    async *_rawEntries() {
        for await (const [key, value] of this.db.iterator()) {
            yield [String(key), value];
        }
    }

    /**
     * Write a raw key/value pair directly into the root LevelDB instance,
     * bypassing the sublevel abstraction, using sync:false for performance.
     * Used by fs_to_db unification adapter for individual key writes.
     *
     * Call _rawSync() once after all bulk unification writes are done to
     * ensure the writes are flushed to durable storage.
     *
     * The `stringToNodeKeyString` conversion is required to satisfy the JSDoc
     * static typing expectations: `this.db` is documented as using
     * `NodeKeyString` keys, so its `put` method is typed to require a
     * `NodeKeyString`. At runtime `stringToNodeKeyString` is effectively a
     * no-op, so the raw sublevel-prefixed key passes through unchanged.
     *
     * @param {string} key
     * @param {*} value
     * @returns {Promise<void>}
     */
    async _rawPut(key, value) {
        // Avoid TypeScript excess-property checking by using a variable.
        // Level's PutOptions type isn't visible here (typed as AbstractLevel),
        // but classic-level supports sync at runtime.
        const opts = { sync: false };
        await this.db.put(stringToNodeKeyString(key), value, opts);
    }

    /**
     * Delete a raw key directly from the root LevelDB instance,
     * bypassing the sublevel abstraction, using sync:false for performance.
     * Mirrors _rawPut(): used by fs_to_db unification adapter for individual
     * key deletes.
     *
     * Call _rawSync() once after all bulk unification writes are done to
     * ensure the writes are flushed to durable storage.
     *
     * @param {string} key
     * @returns {Promise<void>}
     */
    async _rawDel(key) {
        // Avoid TypeScript excess-property checking by using a variable.
        const opts = { sync: false };
        await this.db.del(stringToNodeKeyString(key), opts);
    }

    /**
     * Force a single LevelDB fsync after a bulk unification pass.
     *
     * All writes issued by the unification adapters use sync:false (no per-write
     * fsync) for performance.  This method submits an empty batch with sync:true,
     * which causes LevelDB to flush the WAL up to and including all preceding
     * writes without modifying any data.
     *
     * Must be called once after all unification writes are complete.
     *
     * @returns {Promise<void>}
     */
    async _rawSync() {
        // An empty batch with sync:true is a no-op for data but forces LevelDB
        // to flush the WAL, ensuring all preceding sync:false writes are durable.
        // Use a variable to avoid TypeScript excess-property checking on the
        // batch options (classic-level adds sync to AbstractBatchOptions).
        const opts = { sync: true };
        await this.db.batch([], opts);
    }

    /**
     * Writes many raw key/value pairs directly into the root LevelDB instance
     * using chunked batches. Chunking keeps large restores efficient without
     * building one huge batch object in memory; an empty input array simply
     * results in no batch writes.
     * @param {Array<{ key: string, value: * }>} entries
     * @returns {Promise<void>}
     */
    async _rawPutAll(entries) {
        /**
         * Converts a plain raw-entry object into a LevelDB batch put operation,
         * applying the JSDoc-level NodeKeyString wrapper expected by this.db.
         * @param {{ key: string, value: * }} entry
         * @returns {{ type: 'put', key: NodeKeyString, value: * }}
         */
        function makePutOp(entry) {
            return {
                type: 'put',
                key: stringToNodeKeyString(entry.key),
                value: entry.value,
            };
        }

        for (let i = 0; i < entries.length; i += RAW_BATCH_CHUNK_SIZE) {
            const chunk = entries.slice(i, i + RAW_BATCH_CHUNK_SIZE);
            await this.db.batch(chunk.map(makePutOp));
        }
    }

    /**
     * Deletes a list of raw LevelDB keys in a single batch.
     * Callers are responsible for chunking (keeping the array ≤ RAW_BATCH_CHUNK_SIZE).
     * Used by FS→DB unification to remove stale keys without clearing the
     * entire sublevel.
     *
     * @param {string[]} keys - Full raw LevelDB keys to delete.
     * @returns {Promise<void>}
     */
    async _rawDeleteKeys(keys) {
        await this.db.batch(keys.map(k => ({ type: 'del', key: stringToNodeKeyString(k) })));
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
 * Factory function to create a RootDatabase instance.
 *
 * On first open (no format marker present), writes the format marker and
 * initialises `_meta/current_replica` to `"x"` for a fresh database.
 *
 * For an existing database without a `current_replica` pointer (legacy or
 * partially-initialised), defaults to `"x"` and writes the pointer so future
 * opens are consistent.
 *
 * Throws if the format marker does not match (incompatible layout) or if the
 * stored `current_replica` value is not `"x"` or `"y"`.
 *
 * @param {RootDatabaseCapabilities} capabilities - The capabilities required to create the database
 * @param {string} databasePath - Path to the database directory
 * @returns {Promise<RootDatabaseClass>}
 */
async function makeRootDatabase(capabilities, databasePath) {
    const version = stringToVersion(await getVersion(capabilities));
    /** @type {RootLevelType} */
    const db = capabilities.levelDatabase.initialize(databasePath);

    // Try several times to open the database.
    for (const attempt of [1, 2, 3, 4, 5]) {
        try {
            await db.open();
            break; // Success, exit the retry loop
        } catch (error) {
            if (attempt === 5) {
                // Final attempt failed, rethrow the error
                throw error instanceof Error ? error : new Error(String(error));
            }
            capabilities.logger.logDebug(
                { databasePath, attempt, error, message: error instanceof Error ? error.message : String(error) },
                `Attempt ${attempt} to open database failed. Retrying...`
            );
        }
    }

    // Check the root-level format marker to ensure we are using the x/y namespace layout.
    const rootMetaSublevel = db.sublevel('_meta', { valueEncoding: 'json' });
    const formatMarker = await rootMetaSublevel.get('format');
    if (formatMarker === undefined) {
        // Fresh database: write the format marker and the initial replica pointer.
        await rootMetaSublevel.put('format', FORMAT_MARKER);
        await rootMetaSublevel.put('current_replica', 'x');
        return new RootDatabaseClass(db, version, 'x');
    } else if (formatMarker !== FORMAT_MARKER) {
        // Existing database with an incompatible format — refuse to open.
        await db.close();
        throw new Error(`Database format marker mismatch: expected "${FORMAT_MARKER}", found "${formatMarker}". This may indicate an old database layout or a corrupted database. Please ensure the database is correct or delete it to start fresh.`);
    }

    // Read the current replica pointer.
    const storedReplica = await rootMetaSublevel.get('current_replica');
    if (storedReplica === undefined) {
        await db.close();
        throw new InvalidReplicaPointerError("none");
    }
    if (storedReplica !== 'x' && storedReplica !== 'y') {
        await db.close();
        throw new InvalidReplicaPointerError(storedReplica);
    }

    return new RootDatabaseClass(db, version, storedReplica);
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
    FORMAT_MARKER,
    makeRootDatabase,
    isRootDatabase,
    isInvalidReplicaPointerError,
    isSwitchReplicaError,
    isSchemaBatchVersionError,
    RAW_BATCH_CHUNK_SIZE,
};
