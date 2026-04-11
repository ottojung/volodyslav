/**
 * DB-to-DB unification adapter.
 *
 * Unifies one SchemaStorage into another by iterating all data sublevels
 * (values, freshness, inputs, revdeps, counters, timestamps) as a unified
 * key space.  Only puts keys whose serialised value differs; deletes keys
 * absent from the source.
 *
 * The meta/version sublevel is deliberately excluded — callers must manage
 * the version field separately (e.g. via setMetaVersionForReplica).
 *
 * Key format: "{sublevel}\x00{nodeKey}" where \x00 is used as an unambiguous
 * separator that cannot appear in either sublevel names or NodeKey JSON strings.
 *
 * Writes are applied immediately (no buffering).  Each put/delete is issued as
 * a single-element batch to SchemaStorage.batch().  This keeps peak memory at
 * O(max_value_size) and avoids any need for commit/rollback lifecycle methods.
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

const { stringToNodeKeyString } = require('../types');

/** @typedef {import('../root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./core').UnificationAdapter} UnificationAdapter */
/** @typedef {import('../types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import('../types').NodeKeyString} NodeKeyString */

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
 * @property {ReadableSublevel} inputs
 * @property {ReadableSublevel} revdeps
 * @property {ReadableSublevel} counters
 * @property {ReadableSublevel} timestamps
 */

/**
 * Union of all concrete typed sublevels in a SchemaStorage.
 * Used for the target side only (where put/del ops must be typed).
 *
 * @typedef {import('../root_database').ValuesDatabase | import('../root_database').FreshnessDatabase | import('../root_database').InputsDatabase | import('../root_database').RevdepsDatabase | import('../root_database').CountersDatabase | import('../root_database').TimestampsDatabase} AnySubDb
 */

/**
 * The data sublevel names covered by this adapter, in alphabetical order.
 * Alphabetical order ensures that composite keys "{sublevel}\x00{nodeKey}" are
 * globally sorted (because 'c' < 'f' < 'i' < 'r' < 't' < 'v'), which is
 * required for the merge-join in core.js to produce correct results.
 * The meta/version sublevel is intentionally excluded.
 * @type {readonly string[]}
 */
const DATA_SUBLEVELS = Object.freeze([
    'counters',
    'freshness',
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
        case 'inputs': return storage.inputs;
        case 'revdeps': return storage.revdeps;
        case 'counters': return storage.counters;
        case 'timestamps': return storage.timestamps;
        default: throw new Error(`Unknown sublevel name: ${sublevel}`);
    }
}

/**
 * Create a typed put operation for the given target sublevel.
 * Uses rawPutOp which accepts unknown values but preserves the typed putOp
 * boundary for normal callers.  The value IS the correct runtime type because
 * source and target share the same schema (DB→DB copy invariant).
 *
 * @param {SchemaStorage} target
 * @param {string} sublevel
 * @param {NodeKeyString} key
 * @param {unknown} value
 * @returns {DatabaseBatchOperation}
 */
function makeSublevelPutOp(target, sublevel, key, value) {
    switch (sublevel) {
        case 'values':   return target.values.rawPutOp(key, value);
        case 'freshness': return target.freshness.rawPutOp(key, value);
        case 'inputs':   return target.inputs.rawPutOp(key, value);
        case 'revdeps':  return target.revdeps.rawPutOp(key, value);
        case 'counters': return target.counters.rawPutOp(key, value);
        case 'timestamps': return target.timestamps.rawPutOp(key, value);
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
 * Writes are applied immediately: each putTarget/deleteTarget call issues a
 * single-element target.batch() right away.  No commit/rollback is needed.
 * Atomicity is guaranteed at the replica-cutover level (see module-level note).
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
            await target.batch([makeSublevelPutOp(target, sublevel, stringToNodeKeyString(nodeKey), value)]);
        },

        async deleteTarget(compositeKey) {
            const { sublevel, nodeKey } = parseCompositeKey(compositeKey);
            await target.batch([getTargetSubDb(target, sublevel).delOp(stringToNodeKeyString(nodeKey))]);
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
 * @returns {{ values: object, freshness: object, inputs: object, revdeps: object, counters: object, timestamps: object, batch: function, _stores: object }}
 */
function makeInMemorySchemaStorage() {
    /** @type {Map<string, unknown>} */
    const valuesStore = new Map();
    /** @type {Map<string, unknown>} */
    const freshnessStore = new Map();
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
            async del(/** @type {string} */ key) {
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
                // Sort keys so the in-memory store yields in the same
                // lexicographic order as LevelDB, which is required by the
                // merge-join in core.js.
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
        inputs: makeSubstorage(inputsStore, 'inputs'),
        revdeps: makeSubstorage(revdepsStore, 'revdeps'),
        counters: makeSubstorage(countersStore, 'counters'),
        timestamps: makeSubstorage(timestampsStore, 'timestamps'),
        batch,
        _stores: {
            values: valuesStore,
            freshness: freshnessStore,
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
