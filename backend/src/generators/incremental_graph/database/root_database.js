/* eslint volodyslav/max-lines-per-file: "off" */
/**
 * RootDatabase module.
 * Provides replica-pointer-aware storage using LevelDB sublevels.
 * Each RootDatabase instance tracks the active replica via `_meta/current_replica`.
 */

const { getVersion } = require('../../../version');
const random = require('../../../random');
const { makeTypedDatabase } = require('./typed_database');
const { stringToVersion, stringToNodeKeyString, versionToString } = require('./types');
const { RAW_BATCH_CHUNK_SIZE } = require('./constants');
const {
    IDENTIFIERS_KEY,
    cloneIdentifierLookup,
    makeEmptyIdentifierLookup,
    makeIdentifierLookup,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    serializeIdentifierLookup,
} = require('./identifier_lookup');
const { makeNodeIdentifier } = require('./node_identifier');
const {
    hostnameSchemaStorage: hostnameSchemaStorageHelper,
    clearHostnameStorage: clearHostnameStorageHelper,
    getHostnameGlobalVersion: getHostnameGlobalVersionHelper,
    setHostnameGlobal: setHostnameGlobalHelper,
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
/** @typedef {import('./types').GlobalSublevelType} GlobalSublevelType */
/** @typedef {import('./types').SublevelFormat} SublevelFormat */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').Counter} Counter */
/** @typedef {import('./types').TimestampRecord} TimestampRecord */
/** @typedef {import('./types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import('./types').DatabaseKey} DatabaseKey */
/** @typedef {import('./types').DatabaseStoredValue} DatabaseStoredValue */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./node_identifier').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').Version} Version */
/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */

/**
 * Common base type for any abstract-level database instance at any nesting depth.
 * Both `Level<K, V>` and `AbstractSublevel<Parent, F, K, V>` extend this base,
 * so it can represent both the root database and any nested sublevel.
 * Used as a looser parameter type for internal helpers that only need the shared
 * abstract-level API (sublevel(), batch(), etc.).
 * @typedef {import('abstract-level').AbstractLevel<SublevelFormat, string, DatabaseStoredValue>} AnyLevelType
 */

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
 * @template K
 * @typedef {import('./typed_database').GenericDatabase<T, K>} GenericDatabase
 */

/**
 * Database for storing node output values.
 * Key: persisted node identifier (e.g., "nodecachex")
 * Value: the computed value (object with type field)
 * @typedef {GenericDatabase<ComputedValue, NodeKeyString>} ValuesDatabase
 */

/**
 * Database for storing node freshness state.
 * Key: persisted node identifier (e.g., "nodecachex")
 * Value: freshness state ('up-to-date' | 'potentially-outdated')
 * @typedef {GenericDatabase<Freshness, NodeKeyString>} FreshnessDatabase
 */

/**
 * A record storing the input dependencies of a node and their counters.
 * @typedef {object} InputsRecord
 * @property {string[]} inputs - Array of persisted input identifiers, kept in the original input order.
 * @property {number[]} inputCounters - Array of counter values for each input (required when inputs.length > 0)
 */

/**
 * Database for storing node input dependencies.
 * Key: persisted node identifier
 * Value: inputs record with identifier-addressed dependencies
 * @typedef {GenericDatabase<InputsRecord, NodeKeyString>} InputsDatabase
 */

/**
 * Database for reverse dependency index.
 * Key: persisted input identifier
 * Value: array of dependent identifiers sorted lexicographically by identifier
 * @typedef {GenericDatabase<NodeKeyString[], NodeKeyString>} RevdepsDatabase
 */

/**
 * Database for storing node counters.
 * Key: persisted node identifier
 * Value: counter (monotonic integer tracking value changes)
 * @typedef {GenericDatabase<Counter, NodeKeyString>} CountersDatabase
 */

/**
 * Database for storing node timestamps (creation and modification times).
 * Key: persisted node identifier
 * Value: timestamp record with createdAt and modifiedAt ISO strings
 * @typedef {GenericDatabase<TimestampRecord, NodeKeyString>} TimestampsDatabase
 */

/**
 * Database for storing replica-level global state (e.g., version).
 * Key: plain string (e.g., 'version' or 'identifiers_keys_map')
 * Value: version string or identifier lookup metadata
 * @typedef {GenericDatabase<Version, string>} GlobalVersionDatabase
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
 * @property {GlobalVersionDatabase} global - Replica-level global state (version + identifiers lookup metadata)
 * @property {(operations: DatabaseBatchOperation[]) => Promise<void>} batch - Batch operation interface for atomic writes
 */

/**
 * @param {GlobalSublevelType} globalSublevel
 * @returns {Promise<IdentifierLookup>}
 */
async function loadIdentifierLookupFromGlobal(globalSublevel) {
    const rawEntries = await globalSublevel.get(IDENTIFIERS_KEY);
    if (rawEntries === undefined) {
        return makeEmptyIdentifierLookup();
    }
    if (!Array.isArray(rawEntries)) {
        return makeEmptyIdentifierLookup();
    }
    return makeIdentifierLookup(rawEntries);
}

/**
 * @template T
 * @typedef {import('./types').SimpleSublevel<T>} SimpleSublevel
 */

/**
 * Build a SchemaStorage for one replica namespace.
 * The returned storage's `batch` function verifies the replica's global/version on
 * the first write (initialising it when absent, or throwing on mismatch), then
 * caches the result so subsequent batches pay no I/O overhead for the check.
 *
 * When the replica is cleared (`clearReplicaStorage`), a fresh SchemaStorage is
 * built by the owner so the version-initialisation cache is reset.
 *
 * @param {SchemaSublevelType} namespaceSublevel - The replica's top-level sublevel.
 * @param {GlobalSublevelType} globalSublevel - The replica's global sublevel (`<ns>/global`).
 * @param {Version} version - The current application version.
 * @returns {SchemaStorage}
 */
function buildSchemaStorage(namespaceSublevel, globalSublevel, version) {
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

    // True once this closure's first batch() verifies/writes global/version.
    // Prevents redundant DB reads on subsequent batch calls.
    // Reset to false by rebuilding this SchemaStorage inside clearReplicaStorage().
    let touchedSchema = false;

    /** @type {(operations: DatabaseBatchOperation[]) => Promise<void>} */
    const batch = async (operations) => {
        if (operations.length === 0) {
            return;
        }
        if (!touchedSchema) {
            const existing = await globalSublevel.get('version');
            if (existing === undefined) {
                // New or freshly-cleared namespace: write version to global to initialise.
                await globalSublevel.put('version', version);
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
        global: makeTypedDatabase(globalSublevel),
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
     * Global sublevels for each replica (used by getGlobalVersion / setGlobalVersion).
     * @private
     * @type {GlobalSublevelType}
     */
    _xGlobalSublevel;

    /**
     * @private
     * @type {GlobalSublevelType}
     */
    _yGlobalSublevel;

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
     * @private
     * @type {import('../../../random/seed').NonDeterministicSeed}
     */
    _seed;

    /**
     * @private
     * @type {IdentifierLookup}
     */
    _xIdentifierLookup;

    /**
     * @private
     * @type {IdentifierLookup}
     */
    _yIdentifierLookup;

    /**
     * @constructor
     * @param {RootLevelType} db - The Level database instance
     * @param {Version} version - The current application version
     * @param {ReplicaName} currentReplicaName - The initially active replica ("x" or "y")
     * @param {import('../../../random/seed').NonDeterministicSeed | undefined} seed
     */
    constructor(db, version, currentReplicaName, seed) {
        this.db = db;
        this.version = version;
        this._cachedValueOfCurrentReplica = currentReplicaName;
        this._seed = seed ?? random.seed.make();

        // Root-level _meta sublevel for the replica pointer.
        this._rootMetaSublevel = db.sublevel('_meta', { valueEncoding: 'json' });

        // Build per-replica sublevels and schema storages.
        this._xNamespaceSublevel = db.sublevel('x', { valueEncoding: 'json' });
        this._yNamespaceSublevel = db.sublevel('y', { valueEncoding: 'json' });
        this._xGlobalSublevel = this._xNamespaceSublevel.sublevel('global', { valueEncoding: 'json' });
        this._yGlobalSublevel = this._yNamespaceSublevel.sublevel('global', { valueEncoding: 'json' });
        this._xSchemaStorage = buildSchemaStorage(this._xNamespaceSublevel, this._xGlobalSublevel, version);
        this._ySchemaStorage = buildSchemaStorage(this._yNamespaceSublevel, this._yGlobalSublevel, version);
        this._xIdentifierLookup = makeEmptyIdentifierLookup();
        this._yIdentifierLookup = makeEmptyIdentifierLookup();
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
     * @private
     * @param {ReplicaName} name
     * @returns {IdentifierLookup}
     */
    _identifierLookupForReplica(name) {
        if (name === 'x') {
            return this._xIdentifierLookup;
        }
        if (name === 'y') {
            return this._yIdentifierLookup;
        }
        return assertNeverReplicaName(name);
    }

    /**
     * @private
     * @param {ReplicaName} name
     * @param {IdentifierLookup} lookup
     * @returns {void}
     */
    _setIdentifierLookupForReplica(name, lookup) {
        if (name === 'x') {
            this._xIdentifierLookup = lookup;
            return;
        }
        if (name === 'y') {
            this._yIdentifierLookup = lookup;
            return;
        }
        assertNeverReplicaName(name);
    }

    /**
     * @param {ReplicaName} name
     * @returns {IdentifierLookup}
     */
    cloneIdentifierLookupForReplica(name) {
        return cloneIdentifierLookup(this._identifierLookupForReplica(name));
    }

    /**
     * @returns {IdentifierLookup}
     */
    cloneActiveIdentifierLookup() {
        return this.cloneIdentifierLookupForReplica(this.currentReplicaName());
    }

    /**
     * @param {ReplicaName} name
     * @param {IdentifierLookup} lookup
     * @returns {Promise<void>}
     */
    async replaceIdentifierLookupForReplica(name, lookup) {
        const globalDatabase =
            name === 'x' ? this._xSchemaStorage.global : this._ySchemaStorage.global;
        await globalDatabase.rawPut(IDENTIFIERS_KEY, serializeIdentifierLookup(lookup));
        this._setIdentifierLookupForReplica(name, lookup);
    }

    /**
     * @param {IdentifierLookup} lookup
     * @returns {void}
     */
    replaceActiveIdentifierLookup(lookup) {
        this._setIdentifierLookupForReplica(this.currentReplicaName(), lookup);
    }

    /**
     * @param {NodeKeyString} nodeKey
     * @returns {NodeIdentifier | undefined}
     */
    nodeKeyToId(nodeKey) {
        return nodeKeyToIdFromLookup(
            this._identifierLookupForReplica(this.currentReplicaName()),
            nodeKey
        );
    }

    /**
     * @param {NodeIdentifier} nodeIdentifier
     * @returns {NodeKeyString | undefined}
     */
    nodeIdToKey(nodeIdentifier) {
        return nodeIdToKeyFromLookup(
            this._identifierLookupForReplica(this.currentReplicaName()),
            nodeIdentifier
        );
    }

    /**
     * @returns {NodeIdentifier}
     */
    generateNodeIdentifier() {
        return makeNodeIdentifier({ seed: this._seed ?? random.seed.make() });
    }

    /**
     * @returns {Promise<void>}
     */
    async initializeIdentifierLookups() {
        this._xIdentifierLookup = await loadIdentifierLookupFromGlobal(this._xGlobalSublevel);
        this._yIdentifierLookup = await loadIdentifierLookupFromGlobal(this._yGlobalSublevel);
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
     * Get the app version string stored in the currently active replica's global sublevel.
     * Returns undefined if no version has been recorded yet (fresh database).
     * @returns {Promise<Version | undefined>}
     */
    async getGlobalVersion() {
        const current = this._cachedValueOfCurrentReplica;
        let globalSublevel;
        if (current === 'x') {
            globalSublevel = this._xGlobalSublevel;
        } else if (current === 'y') {
            globalSublevel = this._yGlobalSublevel;
        } else {
            return assertNeverReplicaName(current);
        }
        return await globalSublevel.get('version');
    }

    /**
     * Write the app version string into the currently active replica's global sublevel.
     * @param {Version} version
     * @returns {Promise<void>}
     */
    async setGlobalVersion(version) {
        const current = this._cachedValueOfCurrentReplica;
        let globalSublevel;
        if (current === 'x') {
            globalSublevel = this._xGlobalSublevel;
        } else if (current === 'y') {
            globalSublevel = this._yGlobalSublevel;
        } else {
            return assertNeverReplicaName(current);
        }
        await globalSublevel.put('version', version);
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
            this._xSchemaStorage = buildSchemaStorage(this._xNamespaceSublevel, this._xGlobalSublevel, this.version);
            this._xIdentifierLookup = await loadIdentifierLookupFromGlobal(this._xGlobalSublevel);
        } else if (name === 'y') {
            await this._yNamespaceSublevel.clear();
            // Rebuild to reset the version-initialisation cache in the new closure.
            this._ySchemaStorage = buildSchemaStorage(this._yNamespaceSublevel, this._yGlobalSublevel, this.version);
            this._yIdentifierLookup = await loadIdentifierLookupFromGlobal(this._yGlobalSublevel);
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
     * Reads the app version stored in a hostname's staging global sublevel.
     * Returns `undefined` when the hostname storage contains no version entry.
     * @param {string} hostname
     * @returns {Promise<Version | undefined>}
     */
    async getHostnameGlobalVersion(hostname) {
        return getHostnameGlobalVersionHelper(this.db, hostname);
    }

    /**
     * Write a key/value pair into a hostname's staging global sublevel.
     * @param {string} hostname
     * @param {string} key - The key to write (e.g. 'version').
     * @param {*} value - The value to store.
     * @returns {Promise<void>}
     */
    async setHostnameGlobal(hostname, key, value) {
        return setHostnameGlobalHelper(this.db, hostname, key, value);
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
     * Iterates over all raw key/value pairs belonging to one top-level LevelDB
     * sublevel.  Unlike `_rawEntries()`, this method only reads the requested
     * sublevel (via abstract-level's built-in range scoping) instead of scanning
     * the entire database and filtering by prefix.
     *
     * Each yielded key is the full root-level key (e.g. `!x!!values!...` or
     * `!_meta!current_replica`) reconstructed by prepending `!<sublevelName>!` to the
     * key returned by the sublevel iterator.
     *
     * @param {string} sublevelName - Top-level sublevel name (e.g. "x", "_meta").
     * @returns {AsyncIterable<[string, unknown]>}
     */
    async *_rawEntriesForSublevel(sublevelName) {
        /** @type {SchemaSublevelType} */
        const sublevel = this.db.sublevel(sublevelName, { valueEncoding: 'json' });
        for await (const [key, value] of sublevel.iterator()) {
            yield [`!${sublevelName}!` + key, value];
        }
    }

    /**
     * Iterate over raw keys (no values) in a named top-level LevelDB sublevel.
     * Like _rawEntriesForSublevel() but skips value decoding for callers that
     * only need the key stream (e.g. listSourceKeys / listTargetKeys in the
     * unification adapters).  Each yielded key is the full root-level key
     * (e.g. `!x!!values!...`) reconstructed by prepending `!<sublevelName>!`.
     *
     * @param {string} sublevelName - Top-level sublevel name (e.g. "x", "_meta").
     * @returns {AsyncIterable<string>}
     */
    async *_rawKeysForSublevel(sublevelName) {
        /** @type {SchemaSublevelType} */
        const sublevel = this.db.sublevel(sublevelName, { valueEncoding: 'json' });
        for await (const key of sublevel.keys()) { yield `!${sublevelName}!` + String(key); }
    }

    /**
     * Read a single raw value from a named sublevel by its inner key.
     * The innerKey is the portion of the raw LevelDB key after the
     * "!{sublevelName}!" prefix.  Returns undefined if not found.
     *
     * @param {string} sublevelName - Top-level sublevel name (e.g. "x", "_meta").
     * @param {string} innerKey - Key within the sublevel.
     * @returns {Promise<unknown | undefined>}
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
        // Pass sync:false to avoid per-write fsyncs during bulk unification.
        // classic-level supports sync at runtime; abstract-level's AbstractPutOptions
        // is a "weak type" (all-optional properties) so TypeScript requires at least
        // one recognised property to be present. keyEncoding:undefined is a valid
        // AbstractPutOptions property and satisfies the weak-type check without
        // changing runtime behaviour.
        const opts = { sync: false, keyEncoding: undefined };
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
        // Pass sync:false to avoid per-write fsyncs during bulk unification.
        // See _rawPut() for the keyEncoding:undefined weak-type-check workaround.
        const opts = { sync: false, keyEncoding: undefined };
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
        // keyEncoding:undefined is included so the options object has at least one
        // recognised AbstractBatchOptions property, satisfying TypeScript's weak-type
        // check without changing runtime behaviour.
        const opts = { keyEncoding: undefined, sync: true };
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
 * @property {import('../../../random/seed').NonDeterministicSeed} [seed] - Random seed capability for identifier allocation.
 */

/**
 * Factory function to create a RootDatabase instance.
 *
 * On first open, initialises `_meta/current_replica` to `"x"` for a fresh database.
 *
 * For an existing database without a `current_replica` pointer (legacy or
 * partially-initialised), defaults to `"x"` and writes the pointer so future
 * opens are consistent.
 *
 * Throws if the stored `current_replica` value is not `"x"` or `"y"`.
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

    const rootMetaSublevel = db.sublevel('_meta', { valueEncoding: 'json' });
    const storedReplica = await rootMetaSublevel.get('current_replica');
    if (storedReplica === undefined) {
        await rootMetaSublevel.put('current_replica', 'x');
        const rootDatabase = new RootDatabaseClass(db, version, 'x', capabilities.seed);
        await rootDatabase.initializeIdentifierLookups();
        return rootDatabase;
    }
    if (storedReplica !== 'x' && storedReplica !== 'y') {
        await db.close();
        throw new InvalidReplicaPointerError(storedReplica);
    }

    const rootDatabase = new RootDatabaseClass(db, version, storedReplica, capabilities.seed);
    await rootDatabase.initializeIdentifierLookups();
    return rootDatabase;
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
    isInvalidReplicaPointerError,
    isSwitchReplicaError,
    isSchemaBatchVersionError,
    RAW_BATCH_CHUNK_SIZE,
};
