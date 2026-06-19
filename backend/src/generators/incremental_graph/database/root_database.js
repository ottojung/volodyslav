/* eslint volodyslav/max-lines-per-file: "off" */
/**
 * RootDatabase module.
 * Provides replica-pointer-aware storage using LevelDB sublevels.
 * Each RootDatabase instance tracks the active replica via `_meta/current_replica`.
 */

const { getVersion } = require('../../../version');
const random = require('../../../random');
const { makeTypedDatabase } = require('./typed_database');
const {
    stringToVersion,
    unsafeStringToNodeIdentifier,
    versionToString,
} = require('./types');
const { RAW_BATCH_CHUNK_SIZE } = require('./constants');
const { GRAPH_SCHEME_KEY } = require('./graph_scheme');
const {
    IDENTIFIERS_KEY,
    cloneIdentifierLookup,
    makeEmptyIdentifierLookup,
    makeIdentifierLookup,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
} = require('./identifier_lookup');
const { makeNodeIdentifier, nodeIdentifierToString } = require('./node_identifier');
const { requireValidFingerprint } = require('./fingerprint');

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
    MalformedIdentifierLookupError,
    isMalformedIdentifierLookupError,
    MissingIdentifierLookupError,
    isMissingIdentifierLookupError,
} = require('./replica_errors');

/** @typedef {import('./types').RootLevelType} RootLevelType */
/** @typedef {import('./types').SchemaSublevelType} SchemaSublevelType */
/** @typedef {import('./types').GlobalSublevelType} GlobalSublevelType */
/** @typedef {import('./types').SublevelFormat} SublevelFormat */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').TimestampRecord} TimestampRecord */
/** @typedef {import('./types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import('./types').DatabaseKey} DatabaseKey */
/** @typedef {import('./types').DatabaseStoredValue} DatabaseStoredValue */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').Version} Version */
/** @typedef {import('./types').IdentifiersKeysMap} IdentifiersKeysMap */
/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/**
 * Compiled active-replica state that CAN be reconstructed from a database
 * snapshot. Every field in this struct is derivable from the persisted on-disk
 * state: opening any replica's sublevels and reading its `identifiers_keys_map`
 * yields the same `ActiveReplicaComputed`. Nothing here is ephemeral or
 * in-process-only — it is an *injection* of the durable database into memory.
 *
 * This matters because replica switches (`setCurrentReplicaPointer`) and
 * database reopens rebuild `_computed` from scratch. Any field that cannot be
 * reloaded from disk (e.g. in-flight transaction state) must live outside this
 * struct so it is not lost on every pointer change.
 *
 * **Stale-reference warning:** Callers must not capture sub-properties of an
 * `ActiveReplicaComputed` (e.g. `_computed.schemaStorage`,
 * `_computed.identifierLookup`) across `await` boundaries without holding the
 * appropriate lock. A concurrent `setCurrentReplicaPointer` replaces
 * `_computed` atomically, leaving any captured sub-property pointing at the old
 * replica's state. Use `getSchemaStorage()` / `getActiveIdentifierLookup()` /
 * `cloneActiveIdentifierLookup()` inside each async tick instead of storing
 * references in local variables that cross `await`.
 *
 * @typedef {object} ActiveReplicaComputed
 * @property {ReplicaName} replicaName
 * @property {SchemaSublevelType} namespaceSublevel
 * @property {GlobalSublevelType} globalSublevel
 * @property {SchemaStorage} schemaStorage
 * @property {IdentifierLookup} identifierLookup
 * @property {number} lastNodeIndex
 * @property {string} fingerprint
 */

/**
 * Global metadata key for the monotonic node allocation watermark.
 * Stored in the active replica's global sublevel.
 */
const LAST_NODE_INDEX_KEY = "last_node_index";

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
 * Key: persisted node identifier (e.g., "1-abcdefghi")
 * Value: the computed value (object with type field)
 * @typedef {GenericDatabase<ComputedValue, NodeIdentifier>} ValuesDatabase
 */

/**
 * Database for storing node freshness state.
 * Key: persisted node identifier (e.g., "1-abcdefghi")
 * Value: freshness state ('up-to-date' | 'potentially-outdated')
 * @typedef {GenericDatabase<Freshness, NodeIdentifier>} FreshnessDatabase
 */

/**
 * Database for storing node timestamps (creation and modification times).
 * Key: persisted node identifier
 * Value: timestamp record with createdAt and modifiedAt ISO strings
 * @typedef {GenericDatabase<TimestampRecord, NodeIdentifier>} TimestampsDatabase
 */

/**
 * Database for storing inverse validity flags.
 * Key: persisted dependency identifier
 * Value: sorted array of dependent identifiers whose current values have been
 *        validated with respect to this dependency's current value
 * @typedef {GenericDatabase<NodeIdentifier[], NodeIdentifier>} ValidDatabase
 */

/**
 * Database for storing replica-level global state.
 * Key: plain string (e.g., 'version', 'identifiers_keys_map', 'last_node_index', 'fingerprint')
 * Value: version string, identifier lookup metadata, last_node_index number, fingerprint string
 * @typedef {GenericDatabase<Version | import('./types').IdentifiersKeysMap | number | string, string>} GlobalVersionDatabase
 */

/**
 * Storage container for a single incremental graph namespace.
 * All data (values, freshness, indices) is isolated per namespace.
 * @typedef {object} SchemaStorage
 * @property {ValuesDatabase} values - Node output values
 * @property {FreshnessDatabase} freshness - Node freshness state
 * @property {ValidDatabase} valid - Inverse validity flags (dependency -> dependents validated against it)
 * @property {TimestampsDatabase} timestamps - Node timestamps (creation and modification)
 * @property {GlobalVersionDatabase} global - Replica-level global state (version + identifiers lookup metadata)
 * @property {(operations: DatabaseBatchOperation[]) => Promise<void>} batch - Batch operation interface for atomic writes
 */

/**
 * Read the persisted identifier lookup from a replica's global sublevel.
 * Missing or malformed records cause immediate hard failure — no fallback,
 * no scanning, no self-healing.
 *
 * @param {GlobalSublevelType} globalSublevel
 * @param {string} context
 * @returns {Promise<IdentifierLookup>}
 */
async function loadIdentifierLookupFromGlobal(globalSublevel, context) {
    const rawEntries = await globalSublevel.get(IDENTIFIERS_KEY);
    if (rawEntries === undefined) {
        throw new MissingIdentifierLookupError(context);
    }
    if (!Array.isArray(rawEntries)) {
        throw new MalformedIdentifierLookupError(rawEntries);
    }
    return makeIdentifierLookup(rawEntries);
}

/**
 * @template T
 * @template [K=DatabaseKey]
 * @typedef {import('./types').SimpleSublevel<T, K>} SimpleSublevel
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
    /** @type {SimpleSublevel<ComputedValue, NodeIdentifier>} */
    const valuesSublevel = namespaceSublevel.sublevel('values', { valueEncoding: 'json' });
    /** @type {SimpleSublevel<Freshness, NodeIdentifier>} */
    const freshnessSublevel = namespaceSublevel.sublevel('freshness', { valueEncoding: 'json' });
    /** @type {SimpleSublevel<NodeIdentifier[], NodeIdentifier>} */
    const validSublevel = namespaceSublevel.sublevel('valid', { valueEncoding: 'json' });
    /** @type {SimpleSublevel<TimestampRecord, NodeIdentifier>} */
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
            } else if (typeof existing !== 'string' || existing !== versionToString(version)) {
                // Version mismatch indicates a logic error in migration or usage of staging namespace.
                const foundVersion = typeof existing === 'string'
                    ? stringToVersion(existing)
                    : stringToVersion('invalid-version-record');
                throw new SchemaBatchVersionError(versionToString(version), versionToString(foundVersion));
            }
            touchedSchema = true;
        }
        await namespaceSublevel.batch(operations);
    };

    return {
        batch,
        values: makeTypedDatabase(valuesSublevel),
        freshness: makeTypedDatabase(freshnessSublevel),
        valid: makeTypedDatabase(validSublevel),
        timestamps: makeTypedDatabase(timestampsSublevel),
        global: makeTypedDatabase(globalSublevel),
    };
}

/**
 * Root database class with replica-pointer awareness.
 *
 * Maintains a cached `_meta/current_replica` pointer (always "x" or "y").
 * All active, replica-derived runtime state is represented by `_computed`.
 *
 * `_computed` is an *injection* of the durable database into memory: every
 * field can be reconstructed by opening the replica's sublevels and reading
 * its persisted metadata (version, identifiers_keys_map, last_node_index).
 * Because of this, `setCurrentReplicaPointer` and `clearReplicaStorage`
 * rebuild `_computed` from the on-disk state each time.
 *
 * Ephemeral, in-process-only state (such as `_pendingAllocations` for
 * concurrent identifier allocation) lives directly on the class, NOT inside
 * `_computed`, so it is never discarded on a pointer switch.
 */
class RootDatabaseClass {
    /**
     * The underlying Level database instance.
     * @private
     * @type {RootLevelType}
     */
    db;

    /**
     * @private
     * @type {Version}
     */
    version;

    /**
     * Root-level `_meta` sublevel used to persist the replica pointer.
     * @private
     */
    _rootMetaSublevel;

    /**
      * @private
      * @type {import('../../../random/seed').NonDeterministicSeed}
      */
    _seed;

    /**
      * Active-replica state that is an injection from the durable database.
      * Reconstructed on every replica switch / reopen — never holds ephemeral data.
      * @private
      * @type {ActiveReplicaComputed}
      */
    _computed;

    /**
      * Monotonic counter for the next available node index.
      * Volatile — lives outside `_computed` so it is never discarded on a
      * pointer switch (but is reset from _computed.lastNodeIndex + 1 on
      * every rebuild).
      * @private
      * @type {number}
      */
    _nextNodeIndex;

    /**
      * Key→identifier mappings that have been reserved by in-flight
      * (not-yet-committed) transactions but are not yet in the committed
      * `identifierLookup`.
      * Lives outside `_computed` because it is purely ephemeral — it must NOT
      * be reconstructed from a database snapshot.
      * @private
      * @type {Map<string, string>}
      */
    _pendingAllocations;

    /**
      * Reverse map of _pendingAllocations: identifierString → keyString.
      * Maintained alongside the forward map for O(1) collision checks during
      * identifier reservation — never iterate _pendingAllocations.values().
      * @private
      * @type {Map<string, string>}
      */
    _pendingAllocationsById;

    /**
     * @constructor
     * @param {RootLevelType} db - The Level database instance
     * @param {Version} version - The current application version
     * @param {ReplicaName} currentReplicaName - The initially active replica ("x" or "y")
     * @param {import('../../../random/seed').NonDeterministicSeed} seed - Random seed for fingerprint generation.
     */
    constructor(db, version, currentReplicaName, seed) {
        this.db = db;
        this.version = version;
        this._seed = seed;

        // Root-level _meta sublevel for the replica pointer.
        this._rootMetaSublevel = db.sublevel('_meta', { valueEncoding: 'json' });

        const namespaceSublevel = this.replicaNamespaceSublevel(currentReplicaName);
        const globalSublevel = this.replicaGlobalSublevel(currentReplicaName);
        this._computed = {
            replicaName: currentReplicaName,
            namespaceSublevel,
            globalSublevel,
            schemaStorage: buildSchemaStorage(namespaceSublevel, globalSublevel, version),
            identifierLookup: makeEmptyIdentifierLookup(),
            lastNodeIndex: 0,
            fingerprint: '',
        };

        this._nextNodeIndex = 1;

        // Pending allocations map: purely ephemeral, lives outside _computed
        // because it must not be reconstructed from a database snapshot.
        this._pendingAllocations = new Map();
        this._pendingAllocationsById = new Map();
    }

    /**
     * Get the name of the currently active replica.
     * Synchronous — backed by a cache populated at construction time.
     * @returns {ReplicaName}
     */
    currentReplicaName() {
        return this._computed.replicaName;
    }

    /**
     * @returns {IdentifierLookup}
     */
    cloneActiveIdentifierLookup() {
        return cloneIdentifierLookup(this._computed.identifierLookup);
    }

    /**
     * Return a direct (non-cloned) reference to the active identifier lookup.
     * The caller must treat it as read-only; only `commitTransactionLookup`
     * (called inside `withComputedStateMutex` after a successful flush) may
     * mutate it.
     *
     * This reads `_computed` at call time, so it is safe to call across `await`
     * boundaries. Do NOT capture the returned reference across `await` if a
     * concurrent `setCurrentReplicaPointer` could replace `_computed`.
     * @returns {IdentifierLookup}
     */
    getActiveIdentifierLookup() {
        return this._computed.identifierLookup;
    }

    /**
     * @param {IdentifierLookup} lookup
     * @returns {void}
     */
    replaceActiveIdentifierLookup(lookup) {
        this._computed.identifierLookup = lookup;
    }

    /**
     * @param {import('./types').NodeKeyString} nodeKey
     * @returns {NodeIdentifier | undefined}
     */
    nodeKeyToId(nodeKey) {
        return nodeKeyToIdFromLookup(this._computed.identifierLookup, nodeKey);
    }

    /**
     * @param {NodeIdentifier} nodeIdentifier
     * @returns {import('./types').NodeKeyString | undefined}
     */
    nodeIdToKey(nodeIdentifier) {
        return nodeIdToKeyFromLookup(this._computed.identifierLookup, nodeIdentifier);
    }

    /**
     * Get the database fingerprint.
     * @returns {string}
     */
    getFingerprint() {
        return this._computed.fingerprint;
    }

    /**
     * Allocate a new node identifier using the next available index and the
     * database fingerprint. Returns a deterministic identifier.
     * @returns {NodeIdentifier}
     */
    generateNodeIdentifier() {
        const index = this._nextNodeIndex++;
        return makeNodeIdentifier(this._computed.fingerprint, index);
    }

    /**
     * Get the current allocation watermark (the largest index allocated so
     * far). Used by the transaction commit path to persist the durable
     * `last_node_index`.
     * @returns {number}
     */
    getCurrentAllocationWatermark() {
        return this._nextNodeIndex - 1;
    }

    /**
     * Get the application version known to this database instance.
     * @returns {Version}
     */
    getVersion() {
        return this.version;
    }

    /**
     * Get the committed last node index from in-memory computed state.
     * @returns {number}
     */
    getLastNodeIndex() {
        return this._computed.lastNodeIndex;
    }

    /**
     * Advance the in-memory last node index watermark if the given value
     * is greater than the current one.
     * @param {number} value
     * @returns {void}
     */
    advanceLastNodeIndex(value) {
        this._computed.lastNodeIndex = Math.max(this._computed.lastNodeIndex, value);
    }

    /**
      * Allocate a unique identifier for a node key and claim it in
      * _pendingAllocations for the current in-flight transaction.
      * Synchronous — no await between the read and write, so JavaScript's
      * single-threaded execution guarantees atomicity.
      *
      * The caller must hold the telescope lock for keyString (see pull.js),
      * which serialises all concurrent allocation attempts for the same key.
      * Consequently, _pendingAllocations MUST NOT already contain keyString —
      * if it does, a locking bug exists.
      *
      * Node identifiers are derived from a monotonic counter and the database
      * fingerprint, so collisions are impossible. No retry loop is needed.
      *
      * @param {string} keyString - Serialized node key string.
      * @param {() => NodeIdentifier} makeIdentifier - Synchronous identifier factory.
      * @param {IdentifierLookup} committedLookup - The committed lookup (used for correctness assertion only).
      * @returns {NodeIdentifier} The newly allocated identifier.
      */
    _allocateKeyIdentifier(keyString, makeIdentifier, committedLookup) {
        // The telescope lock per keyString guarantees no concurrent in-flight
        // allocation for this key, so _pendingAllocations must be clean.
        if (this._pendingAllocations.has(keyString)) {
            throw new Error(
                `BUG: pending allocation for key ${keyString} found during allocation under telescope lock`
            );
        }

        const candidate = makeIdentifier();
        const candidateStr = nodeIdentifierToString(candidate);

        // With fingerprint-prefixed identifiers, collisions are impossible
        // within a single database. These checks exist as correctness
        // assertions only.
        if (committedLookup.idToKey.get(candidateStr) !== undefined) {
            throw new Error(
                `BUG: identifier collision with committed lookup: ${candidateStr}`
            );
        }
        if (this._pendingAllocationsById.has(candidateStr)) {
            throw new Error(
                `BUG: identifier collision with pending allocation: ${candidateStr}`
            );
        }

        this._pendingAllocations.set(keyString, candidateStr);
        this._pendingAllocationsById.set(candidateStr, keyString);
        return candidate;
    }

    /**
      * Release pending allocations for keys that this transaction owned.
      * Called in the finally block after commit success or failure.
      * @param {Set<string>} ownedKeys - Key strings owned by the transaction.
      * @returns {void}
      */
    releaseIdentifierReservations(ownedKeys) {
        for (const keyString of ownedKeys) {
            const idStr = this._pendingAllocations.get(keyString);
            this._pendingAllocations.delete(keyString);
            if (idStr !== undefined) {
                this._pendingAllocationsById.delete(idStr);
            }
        }
    }

    /**
     * Write an empty identifiers_keys_map, initial last_node_index, and
     * fingerprint for a fresh replica. Used by makeRootDatabase to ensure
     * loadIdentifierLookupFromGlobal never encounters a missing map.
     * @returns {Promise<void>}
     */
    async writeEmptyIdentifierLookup() {
        await this._computed.globalSublevel.put(IDENTIFIERS_KEY, []);
        await this._computed.globalSublevel.put(LAST_NODE_INDEX_KEY, 0);
        const fingerprint = random.basicString({ seed: this._seed });
        await this._computed.globalSublevel.put('fingerprint', fingerprint);
        this._computed.fingerprint = fingerprint;
    }

    /**
     * Load identifier lookup, last_node_index, and fingerprint from the
     * active replica's global sublevel. Called on database open and replica
     * switch for versioned replicas.
     * @returns {Promise<void>}
     */
    async initializeActiveIdentifierLookup() {
        this._computed.identifierLookup = await loadIdentifierLookupFromGlobal(
            this._computed.globalSublevel,
            `active replica '${this.currentReplicaName()}'`
        );
        const rawLastNodeIndex = await this._computed.globalSublevel.get(LAST_NODE_INDEX_KEY);
        if (typeof rawLastNodeIndex === 'number' && Number.isInteger(rawLastNodeIndex) && rawLastNodeIndex >= 0) {
            this._computed.lastNodeIndex = rawLastNodeIndex;
            this._nextNodeIndex = rawLastNodeIndex + 1;
        } else {
            throw new MissingIdentifierLookupError(
                `active replica '${this.currentReplicaName()}' has a version but missing or invalid last_node_index`
            );
        }
        const storedFingerprint = await this._computed.globalSublevel.get('fingerprint');
        this._computed.fingerprint = requireValidFingerprint(
            storedFingerprint,
            `active replica '${this.currentReplicaName()}' global metadata`
        );
    }

    /**
     * Load the last_node_index from the active replica's global sublevel.
     * Throws if a versioned replica has missing or invalid last_node_index.
     * Returns 0 only for genuinely fresh (un-versioned) replicas.
     * @param {boolean} hasVersion - Whether the replica has a version entry.
     * @returns {Promise<number>}
     */
    async loadLastNodeIndex(hasVersion) {
        const value = await this._computed.globalSublevel.get(LAST_NODE_INDEX_KEY);
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
            return value;
        }
        if (hasVersion) {
            throw new MissingIdentifierLookupError(
                `active replica '${this.currentReplicaName()}' has a version but missing or invalid last_node_index`
            );
        }
        return 0;
    }

    /**
     * @param {ReplicaName} name
     * @returns {Promise<IdentifierLookup>}
     */
    async loadIdentifierLookupForReplica(name) {
        return loadIdentifierLookupFromGlobal(
            this.replicaGlobalSublevel(name),
            `replica '${name}'`
        );
    }

    /**
     * Get the name of the inactive (other) replica.
     * @returns {ReplicaName}
     */
    otherReplicaName() {
        const current = this._computed.replicaName;
        if (current === 'x') {
            return 'y';
        }
        if (current === 'y') {
            return 'x';
        }
        return assertNeverReplicaName(current);
    }

    /**
     * Persist a new active replica pointer in `_meta/current_replica`.
     * On success, refreshes in-memory active replica and active identifier lookup
     * so subsequent calls in the same process immediately observe the cutover.
     * Throws `InvalidReplicaPointerError` for unrecognised names.
     * Throws `SwitchReplicaError` if persisting or refreshing active state fails.
     * @param {ReplicaName} name
     * @returns {Promise<void>}
     */
    async setCurrentReplicaPointer(name) {
        if (name === 'x') {
            // x is valid
        } else if (name === 'y') {
            // y is valid
        } else {
            assertNeverReplicaName(name);
        }
        try {
            const namespaceSublevel = this.replicaNamespaceSublevel(name);
            const globalSublevel = this.replicaGlobalSublevel(name);
            const schemaStorage = buildSchemaStorage(namespaceSublevel, globalSublevel, this.version);
            const hasVersion = await globalSublevel.get('version');
            let identifierLookup;
            let lastNodeIndex;
            let fingerprint;
            if (hasVersion === undefined) {
                identifierLookup = makeEmptyIdentifierLookup();
                lastNodeIndex = 0;
                // Carry forward the existing fingerprint so the machine-local
                // fingerprint is preserved across replica switches.
                fingerprint = this._computed.fingerprint;
                // Write an empty map, initial last_node_index, and fingerprint.
                await globalSublevel.put(IDENTIFIERS_KEY, []);
                await globalSublevel.put(LAST_NODE_INDEX_KEY, 0);
                if (!fingerprint) {
                    fingerprint = random.basicString({ seed: this._seed });
                }
                await globalSublevel.put('fingerprint', fingerprint);
            } else {
                identifierLookup = await loadIdentifierLookupFromGlobal(
                    globalSublevel,
                    `replica '${name}'`
                );
                const rawLastNodeIndex = await globalSublevel.get(LAST_NODE_INDEX_KEY);
                if (typeof rawLastNodeIndex === 'number' && Number.isInteger(rawLastNodeIndex) && rawLastNodeIndex >= 0) {
                    lastNodeIndex = rawLastNodeIndex;
                } else {
                    throw new MissingIdentifierLookupError(
                        `replica '${name}' has a version but missing or invalid last_node_index`
                    );
                }
                const storedFingerprint = await globalSublevel.get('fingerprint');
                fingerprint = requireValidFingerprint(
                    storedFingerprint,
                    `replica '${name}' global metadata`
                );
            }
            await this._rootMetaSublevel.put('current_replica', name);
            this._computed = {
                replicaName: name,
                namespaceSublevel,
                globalSublevel,
                schemaStorage,
                identifierLookup,
                lastNodeIndex,
                fingerprint,
            };
            this._nextNodeIndex = lastNodeIndex + 1;
        } catch (err) {
            throw new SwitchReplicaError(name, err);
        }
    }

    /**
     * Get the SchemaStorage for the currently active replica.
     * Reflects the currently cached active replica pointer.
     *
     * This reads `_computed` at call time — it is safe to call across `await`
     * boundaries. Do NOT capture the returned reference across `await` if a
     * concurrent `setCurrentReplicaPointer` could replace `_computed`.
     * @returns {SchemaStorage}
     */
    getSchemaStorage() {
        return this._computed.schemaStorage;
    }

    /**
     * Get the SchemaStorage for an explicit replica, without changing the active pointer.
     * Used by migration to access both source and target replicas simultaneously.
     * Throws `InvalidReplicaPointerError` for unrecognised names.
     * @param {ReplicaName} name
     * @returns {SchemaStorage}
     */
    schemaStorageForReplica(name) {
        return buildSchemaStorage(
            this.replicaNamespaceSublevel(name),
            this.replicaGlobalSublevel(name),
            this.version
        );
    }

    /**
     * Get the app version string stored in the currently active replica's global sublevel.
     * Returns undefined if no version has been recorded yet (fresh database).
     * @returns {Promise<Version | undefined>}
     */
    async getGlobalVersion() {
        const value = await this._computed.globalSublevel.get('version');
        return typeof value === 'string' ? stringToVersion(value) : undefined;
    }

    /**
     * Write the app version string into the currently active replica's global sublevel.
     * @param {Version} version
     * @returns {Promise<void>}
     */
    async setGlobalVersion(version) {
        await this._computed.globalSublevel.put('version', version);
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
        const namespaceSublevel = this.replicaNamespaceSublevel(name);
        const globalSublevel = this.replicaGlobalSublevel(name);
        await namespaceSublevel.clear();
        if (this.currentReplicaName() === name) {
            this._computed = {
                replicaName: name,
                namespaceSublevel,
                globalSublevel,
                schemaStorage: buildSchemaStorage(namespaceSublevel, globalSublevel, this.version),
                identifierLookup: makeEmptyIdentifierLookup(),
                lastNodeIndex: 0,
                fingerprint: this._computed.fingerprint,
            };
            this._nextNodeIndex = 1;
        }
    }

    /**
     * @param {ReplicaName} name
     * @returns {SchemaSublevelType}
     */
    replicaNamespaceSublevel(name) {
        if (name === 'x' || name === 'y') {
            return this.db.sublevel(name, { valueEncoding: 'json' });
        }
        return assertNeverReplicaName(name);
    }

    /**
     * @param {ReplicaName} name
     * @returns {GlobalSublevelType}
     */
    replicaGlobalSublevel(name) {
        return this.replicaNamespaceSublevel(name).sublevel('global', { valueEncoding: 'json' });
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
     * @param {DatabaseStoredValue} value - The value to store.
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
        return await sublevel.get(unsafeStringToNodeIdentifier(innerKey));
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
     * The `unsafeStringToNodeIdentifier` conversion is required to satisfy the JSDoc
     * static typing expectations: `this.db` is documented as using
     * `NodeIdentifier` keys, so its `put` method is typed to require a
     * `NodeIdentifier`. At runtime `unsafeStringToNodeIdentifier` is effectively a
     * no-op, so the raw sublevel-prefixed key passes through unchanged.
     *
     * @param {string} key
     * @param {unknown} value
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
        await this.db.put(unsafeStringToNodeIdentifier(key), value, opts);
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
        await this.db.del(unsafeStringToNodeIdentifier(key), opts);
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
         * applying the JSDoc-level NodeIdentifier wrapper expected by this.db.
         * @param {{ key: string, value: * }} entry
         * @returns {{ type: 'put', key: DatabaseKey, value: * }}
         */
        function makePutOp(entry) {
            return {
                type: 'put',
                key: unsafeStringToNodeIdentifier(entry.key),
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
        await this.db.batch(keys.map(k => ({ type: 'del', key: unsafeStringToNodeIdentifier(k) })));
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
 * @property {import('../../../random/seed').NonDeterministicSeed} seed - Random seed capability for fingerprint generation.
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
        const replicaName = 'x';
        // Construct the RootDatabase before writing anything so _computed
        // has the correct sublevel handles for the fresh replica.
        const rootDatabase = new RootDatabaseClass(db, version, replicaName, capabilities.seed);
        const hasVersion = await rootDatabase.getGlobalVersion();
        if (hasVersion === undefined) {
            // Write all active-replica metadata first, then write the
            // replica pointer last as the crash-atomic commit step.  If a
            // crash occurs before the pointer write, the next open sees no
            // storedReplica and re-initialises cleanly.
            await rootDatabase.writeEmptyIdentifierLookup();
            await rootMetaSublevel.put('current_replica', replicaName);
            return rootDatabase;
        }
        // Version exists but no current_replica pointer — the active
        // metadata survived a crash that occurred after the metadata
        // writes but before the pointer write in a previous session.
        // Load what is there and write the pointer.
        await rootDatabase.initializeActiveIdentifierLookup();
        await rootMetaSublevel.put('current_replica', replicaName);
        return rootDatabase;
    }
    if (storedReplica !== 'x' && storedReplica !== 'y') {
        await db.close();
        throw new InvalidReplicaPointerError(storedReplica);
    }

    const rootDatabase = new RootDatabaseClass(db, version, storedReplica, capabilities.seed);
    await rootDatabase.initializeActiveIdentifierLookup();
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

module.exports = { GRAPH_SCHEME_KEY,
    makeRootDatabase,
    isRootDatabase,
    isInvalidReplicaPointerError,
    isSwitchReplicaError,
    isSchemaBatchVersionError,
    isMalformedIdentifierLookupError,
    MissingIdentifierLookupError,
    isMissingIdentifierLookupError,
    LAST_NODE_INDEX_KEY,
    RAW_BATCH_CHUNK_SIZE,
};
