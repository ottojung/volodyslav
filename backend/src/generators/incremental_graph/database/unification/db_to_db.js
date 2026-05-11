/**
 * DB-to-DB unification adapter.
 *
 * Unifies one SchemaStorage into another by iterating all data sublevels
 * (values, freshness, global, inputs, revdeps, counters, timestamps) as a unified
 * key space.  Only puts keys whose serialised value differs; deletes keys
 * absent from the source.
 *
 * Key format: "{sublevel}\x00{nodeKey}" where \x00 is used as an unambiguous
 * separator that cannot appear in either sublevel names or NodeKey JSON strings.
 *
 * Writes are applied immediately as differences are discovered, using
 * rawPut()/rawDel() on each target sublevel (no batch() API calls, no
 * buffering).  rawPut/rawDel use sync:false for performance; callers must
 * invoke rootDatabase._rawSync() once after unifyStores() to flush all writes
 * to durable storage with a single fsync.
 * Peak memory is O(max_value_size) — at most one value lives in the call
 * frame at any instant.
 * Atomicity is guaranteed at a higher level by the replica-cutover mechanism.
 *
 * Source type: the source may be any ReadableSchemaStorage — a real
 * SchemaStorage (LevelDB-backed) or a lazy source such as the migration source
 * built in migration_runner.js.  Only the per-sublevel get() and keys()
 * methods are required from the source side.
 *
 * In-memory capture: makeInMemorySchemaStorage() provides an in-memory store
 * that supports get/put/keys and its own batch() that accepts InMemoryBatchOp
 * values.  It satisfies ReadableSchemaStorage so it can be passed as source.
 */

/** @typedef {import('../root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./core').UnificationAdapter} UnificationAdapter */
/** @typedef {import('../types').NodeKeyString} NodeKeyString */

const { stringToNodeKeyString } = require('../types');

/**
 * Read-only view of a single sublevel — the minimum interface required by the
 * source side of the DB→DB adapter.  Both GenericDatabase<T> and the
 * InMemorySchemaStorage sublevels satisfy this interface.
 *
 * @typedef {object} ReadableSublevel
 * @property {(key: NodeKeyString) => Promise<unknown>} get
 * @property {() => AsyncIterable<NodeKeyString>} keys
 */

/**
 * Read-only structural type accepted as source by makeDbToDbAdapter.
 * Both SchemaStorage (via GenericDatabase<T>) and InMemorySchemaStorage
 * satisfy this interface without any casts.
 *
 * @typedef {object} ReadableSchemaStorage
 * @property {ReadableSublevel} values
 * @property {ReadableSublevel} freshness
 * @property {ReadableSublevel} global
 * @property {ReadableSublevel} inputs
 * @property {ReadableSublevel} revdeps
 * @property {ReadableSublevel} counters
 * @property {ReadableSublevel} timestamps
 */

/**
 * Union of all concrete typed sublevels in a SchemaStorage.
 * Used for the target side only (where put/del ops must be typed).
 *
 * @typedef {import('../root_database').ValuesDatabase | import('../root_database').FreshnessDatabase | import('../root_database').GlobalVersionDatabase | import('../root_database').InputsDatabase | import('../root_database').RevdepsDatabase | import('../root_database').CountersDatabase | import('../root_database').TimestampsDatabase} AnySubDb
 */

/**
 * The data sublevel names covered by this adapter, in alphabetical order.
 * Alphabetical order ensures that composite keys "{sublevel}\x00{nodeKey}" are
 * globally sorted (because 'c' < 'f' < 'g' < 'i' < 'r' < 't' < 'v'), which is
 * required for the merge-join in core.js to produce correct results.
 * @type {readonly string[]}
 */
const DATA_SUBLEVELS = Object.freeze([
    'counters',
    'freshness',
    'global',
    'inputs',
    'revdeps',
    'timestamps',
    'values',
]);

/**
 * Separator character used between sublevel name and node key.
 * Chosen as \x00 (null byte) because it cannot appear in sublevel names
 * (simple ASCII words) or in NodeKey JSON strings.
 */
const KEY_SEP = '\x00';

/**
 * @param {string} sublevel
 * @param {string} nodeKey
 * @returns {string}
 */
function makeCompositeKey(sublevel, nodeKey) {
    return sublevel + KEY_SEP + nodeKey;
}

/**
 * @param {string} compositeKey
 * @returns {{ sublevel: string, nodeKey: string }}
 */
function parseCompositeKey(compositeKey) {
    const idx = compositeKey.indexOf(KEY_SEP);
    return {
        sublevel: compositeKey.slice(0, idx),
        nodeKey: compositeKey.slice(idx + 1),
    };
}

// ---------------------------------------------------------------------------
// Source accessor
// ---------------------------------------------------------------------------

/**
 * Returns the ReadableSublevel for the given sublevel name from a source.
 *
 * @param {ReadableSchemaStorage} source
 * @param {string} sublevel
 * @returns {ReadableSublevel}
 */
function getSourceSubDb(source, sublevel) {
    switch (sublevel) {
        case 'values': return source.values;
        case 'freshness': return source.freshness;
        case 'global': return source.global;
        case 'inputs': return source.inputs;
        case 'revdeps': return source.revdeps;
        case 'counters': return source.counters;
        case 'timestamps': return source.timestamps;
        default: throw new Error(`Unknown sublevel name: ${sublevel}`);
    }
}

// ---------------------------------------------------------------------------
// Target accessor
// ---------------------------------------------------------------------------

/**
 * Returns the typed sublevel object from a SchemaStorage.
 * Used only for the target side where put/del ops require concrete types.
 *
 * @param {SchemaStorage} storage
 * @param {string} sublevel
 * @returns {AnySubDb}
 */
function getTargetSubDb(storage, sublevel) {
    switch (sublevel) {
        case 'values': return storage.values;
        case 'freshness': return storage.freshness;
        case 'global': return storage.global;
        case 'inputs': return storage.inputs;
        case 'revdeps': return storage.revdeps;
        case 'counters': return storage.counters;
        case 'timestamps': return storage.timestamps;
        default: throw new Error(`Unknown sublevel name: ${sublevel}`);
    }
}

// ---------------------------------------------------------------------------
// Key iteration
// ---------------------------------------------------------------------------

/**
 * Iterate all (sublevel, key) pairs across a ReadableSchemaStorage.
 * Yields composite keys.
 *
 * @param {ReadableSchemaStorage} source
 * @param {readonly string[]} sublevels - The sublevel names to include.
 * @returns {AsyncIterable<string>}
 */
async function* listAllKeys(source, sublevels) {
    for (const sublevel of sublevels) {
        for await (const key of getSourceSubDb(source, sublevel).keys()) {
            yield makeCompositeKey(sublevel, String(key));
        }
    }
}

// ---------------------------------------------------------------------------
// makeDbToDbAdapter
// ---------------------------------------------------------------------------

/**
 * Create a DB-to-DB unification adapter.
 *
 * Source must implement the ReadableSchemaStorage interface (per-sublevel
 * get() and keys() only).  SchemaStorage (LevelDB-backed), InMemorySchemaStorage,
 * and lazy migration sources all satisfy this interface without any casts.
 *
 * putTarget and deleteTarget write each operation immediately via direct
 * rawPut()/del() calls on the target sublevel (no batch() calls, no buffering).
 * This keeps peak memory at O(max_value_size) — at most one value is live in
 * the call frame at any instant.
 *
 * Memory: O(max_value_size) for the single source/target value held during
 * each individual put operation.
 *
 * @param {ReadableSchemaStorage} source
 * @param {SchemaStorage} target
 * @param {{ excludeSublevels?: string[] }} [options]
 * @returns {UnificationAdapter}
 */
function makeDbToDbAdapter(source, target, options = {}) {
    const { excludeSublevels = [] } = options;
    const sublevels = DATA_SUBLEVELS.filter(s => !excludeSublevels.includes(s));

    return {
        listSourceKeys: () => listAllKeys(source, sublevels),
        listTargetKeys: () => listAllKeys(target, sublevels),

        async readSource(compositeKey) {
            const { sublevel, nodeKey } = parseCompositeKey(compositeKey);
            return await getSourceSubDb(source, sublevel).get(stringToNodeKeyString(nodeKey));
        },

        async readTarget(compositeKey) {
            const { sublevel, nodeKey } = parseCompositeKey(compositeKey);
            return await getTargetSubDb(target, sublevel).get(stringToNodeKeyString(nodeKey));
        },

        equals(sv, tv) {
            return JSON.stringify(sv) === JSON.stringify(tv);
        },

        async putTarget(compositeKey, value) {
            const { sublevel, nodeKey } = parseCompositeKey(compositeKey);
            await getTargetSubDb(target, sublevel).rawPut(stringToNodeKeyString(nodeKey), value);
        },

        async deleteTarget(compositeKey) {
            const { sublevel, nodeKey } = parseCompositeKey(compositeKey);
            await getTargetSubDb(target, sublevel).rawDel(stringToNodeKeyString(nodeKey));
        },
    };
}

// ---------------------------------------------------------------------------
// InMemorySchemaStorage
// ---------------------------------------------------------------------------

/**
 * Batch operation produced by an InMemorySchemaStorage put.
 * Uses a string sublevelTag instead of a sublevel reference, so batch()
 * can dispatch by name without any JSDoc type assertions.
 *
 * @typedef {{ type: 'put', sublevelTag: string, key: string, value: unknown }} InMemoryPutOp
 */

/**
 * Batch operation produced by an InMemorySchemaStorage delete.
 *
 * @typedef {{ type: 'del', sublevelTag: string, key: string }} InMemoryDelOp
 */

/**
 * Union of in-memory batch operation types accepted by InMemorySchemaStorage.batch().
 *
 * @typedef {InMemoryPutOp | InMemoryDelOp} InMemoryBatchOp
 */

/**
 * Create an in-memory SchemaStorage that captures writes for later iteration.
 *
 * The returned object satisfies ReadableSchemaStorage (per-sublevel get/keys),
 * so it can be passed as the source argument to makeDbToDbAdapter.  Its own
 * batch() method accepts InMemoryBatchOp values produced by the per-sublevel
 * putOp/delOp helpers.
 *
 * Unlike a real SchemaStorage, this implementation does NOT perform version
 * checking in batch() — it is intended purely as a temporary capture store for
 * tests or intermediate computation, not as a durable replica.
 *
 * @returns {{ values: object, freshness: object, global: object, inputs: object, revdeps: object, counters: object, timestamps: object, batch: function, _stores: object }}
 */
function makeInMemorySchemaStorage() {
    /** @type {Map<string, unknown>} */
    const valuesStore = new Map();
    /** @type {Map<string, unknown>} */
    const freshnessStore = new Map();
    /** @type {Map<string, unknown>} */
    const globalStore = new Map();
    /** @type {Map<string, unknown>} */
    const inputsStore = new Map();
    /** @type {Map<string, unknown>} */
    const revdepsStore = new Map();
    /** @type {Map<string, unknown>} */
    const countersStore = new Map();
    /** @type {Map<string, unknown>} */
    const timestampsStore = new Map();

    /**
     * @param {Map<string, unknown>} store
     * @param {string} sublevelName
     */
    function makeSubstorage(store, sublevelName) {
        return {
            async get(/** @type {string} */ key) {
                return store.get(String(key));
            },
            async put(/** @type {string} */ key, /** @type {unknown} */ value) {
                store.set(String(key), value);
            },
            // rawPut() is identical to put() at runtime — the distinction exists
            // only at the JSDoc/type level so unification adapters can call it
            // without the TValue constraint while normal callers keep the typed API.
            async rawPut(/** @type {string} */ key, /** @type {*} */ value) {
                store.set(String(key), value);
            },
            async del(/** @type {string} */ key) {
                store.delete(String(key));
            },
            // rawDel() is identical to del() at runtime — mirrors rawPut().
            async rawDel(/** @type {string} */ key) {
                store.delete(String(key));
            },
            /** @returns {InMemoryPutOp} */
            putOp(/** @type {string} */ key, /** @type {unknown} */ value) {
                return { type: 'put', sublevelTag: sublevelName, key: String(key), value };
            },
            /** @returns {InMemoryPutOp} */
            rawPutOp(/** @type {string} */ key, /** @type {*} */ value) {
                return { type: 'put', sublevelTag: sublevelName, key: String(key), value };
            },
            /** @returns {InMemoryDelOp} */
            delOp(/** @type {string} */ key) {
                return { type: 'del', sublevelTag: sublevelName, key: String(key) };
            },
            async *keys() {
                // Sort keys so the in-memory store yields in the same order
                // as LevelDB.  Keys are latin1 strings (no "!!" substring), so
                // JS default string comparison matches byte order.
                const sorted = [...store.keys()].sort();
                for (const k of sorted) {
                    yield stringToNodeKeyString(k);
                }
            },
            async clear() {
                store.clear();
            },
        };
    }

    /**
     * @param {string} tag
     * @returns {Map<string, unknown> | undefined}
     */
    function getStore(tag) {
        switch (tag) {
            case 'values': return valuesStore;
            case 'freshness': return freshnessStore;
            case 'global': return globalStore;
            case 'inputs': return inputsStore;
            case 'revdeps': return revdepsStore;
            case 'counters': return countersStore;
            case 'timestamps': return timestampsStore;
            default: return undefined;
        }
    }

    /**
     * @param {InMemoryBatchOp[]} ops
     * @returns {Promise<void>}
     */
    async function batch(ops) {
        if (ops.length === 0) return;
        for (const op of ops) {
            const store = getStore(op.sublevelTag);
            if (store === undefined) continue;
            if (op.type === 'put') {
                store.set(op.key, op.value);
            } else if (op.type === 'del') {
                store.delete(op.key);
            }
        }
    }

    return {
        values: makeSubstorage(valuesStore, 'values'),
        freshness: makeSubstorage(freshnessStore, 'freshness'),
        global: makeSubstorage(globalStore, 'global'),
        inputs: makeSubstorage(inputsStore, 'inputs'),
        revdeps: makeSubstorage(revdepsStore, 'revdeps'),
        counters: makeSubstorage(countersStore, 'counters'),
        timestamps: makeSubstorage(timestampsStore, 'timestamps'),
        batch,
        _stores: {
            values: valuesStore,
            freshness: freshnessStore,
            global: globalStore,
            inputs: inputsStore,
            revdeps: revdepsStore,
            counters: countersStore,
            timestamps: timestampsStore,
        },
    };
}

module.exports = {
    makeDbToDbAdapter,
    makeInMemorySchemaStorage,
};
