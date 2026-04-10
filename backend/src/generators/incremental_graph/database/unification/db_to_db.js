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
 * Batch buffering: puts and deletes are accumulated and flushed in chunks of
 * RAW_BATCH_CHUNK_SIZE through target.batch() for efficiency.  commit() flushes
 * any remaining buffered operations.  rollback() discards the buffer without
 * flushing (already-flushed writes cannot be undone since LevelDB has no
 * rollback; this is acceptable because crash-safety is handled at a higher
 * level).
 *
 * In-memory source: the source may be either a real SchemaStorage (LevelDB-
 * backed) or an InMemorySchemaStorage produced by makeInMemorySchemaStorage().
 * Both implement the same structural interface (per-sublevel get/keys and a
 * batch method), so the adapter works identically for both.
 */

const { RAW_BATCH_CHUNK_SIZE } = require('../constants');
const { stringToNodeKeyString } = require('../types');

/** @typedef {import('../root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./core').UnificationAdapter} UnificationAdapter */
/** @typedef {import('../types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import('../types').NodeKeyString} NodeKeyString */

/**
 * The data sublevel names covered by this adapter.
 * The meta/version sublevel is intentionally excluded.
 * @type {readonly string[]}
 */
const DATA_SUBLEVELS = Object.freeze([
    'values',
    'freshness',
    'inputs',
    'revdeps',
    'counters',
    'timestamps',
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

/**
 * Stable JSON serialisation for deep equality comparison.
 * Object keys are sorted so {a:1,b:2} and {b:2,a:1} compare as equal.
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return '[' + value.map(stableStringify).join(',') + ']';
    }
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(/** @type {Record<string,unknown>} */ (value)[k])).join(',') + '}';
}

/** @typedef {import('../typed_database').GenericDatabase<unknown>} AnySubDb */

/**
 * Returns the appropriate sublevel object from a SchemaStorage given its name.
 * The return type is erased to `GenericDatabase<unknown>` because this adapter
 * works with opaque values (it only reads, compares via stringify, and writes
 * back the same value it read — so the exact value type is never needed).
 *
 * @param {SchemaStorage} storage
 * @param {string} sublevel
 * @returns {AnySubDb}
 */
function getSubDb(storage, sublevel) {
    switch (sublevel) {
        case 'values': return /** @type {AnySubDb} */ (storage.values);
        case 'freshness': return /** @type {AnySubDb} */ (storage.freshness);
        case 'inputs': return /** @type {AnySubDb} */ (storage.inputs);
        case 'revdeps': return /** @type {AnySubDb} */ (storage.revdeps);
        case 'counters': return /** @type {AnySubDb} */ (storage.counters);
        case 'timestamps': return /** @type {AnySubDb} */ (storage.timestamps);
        default: throw new Error(`Unknown sublevel name: ${sublevel}`);
    }
}

/**
 * Iterate all (sublevel, key) pairs across a SchemaStorage or InMemorySchemaStorage.
 * Yields composite keys.
 *
 * @param {SchemaStorage} storage
 * @param {readonly string[]} sublevels - The sublevel names to include.
 * @returns {AsyncIterable<string>}
 */
async function* listAllKeys(storage, sublevels) {
    for (const sublevel of sublevels) {
        for await (const key of getSubDb(storage, sublevel).keys()) {
            yield makeCompositeKey(sublevel, String(key));
        }
    }
}

/**
 * Create a DB-to-DB unification adapter.
 *
 * Source and target must implement the SchemaStorage interface (or the
 * InMemorySchemaStorage interface, which is structurally compatible).
 *
 * @param {SchemaStorage} source
 * @param {SchemaStorage} target
 * @param {{ excludeSublevels?: string[] }} [options]
 * @returns {UnificationAdapter}
 */
function makeDbToDbAdapter(source, target, options = {}) {
    const { excludeSublevels = [] } = options;
    const sublevels = DATA_SUBLEVELS.filter(s => !excludeSublevels.includes(s));

    /** @type {DatabaseBatchOperation[]} */
    let pendingOps = [];

    /**
     * Flush a chunk of pending ops through the target SchemaStorage batch.
     * @returns {Promise<void>}
     */
    async function flushChunk() {
        if (pendingOps.length === 0) return;
        const chunk = pendingOps.splice(0, RAW_BATCH_CHUNK_SIZE);
        await target.batch(chunk);
    }

    /**
     * Auto-flush when the pending buffer reaches the chunk size.
     * @returns {Promise<void>}
     */
    async function maybeFlush() {
        while (pendingOps.length >= RAW_BATCH_CHUNK_SIZE) {
            await flushChunk();
        }
    }

    return {
        listSourceKeys: () => listAllKeys(source, sublevels),
        listTargetKeys: () => listAllKeys(target, sublevels),

        async readSource(compositeKey) {
            const { sublevel, nodeKey } = parseCompositeKey(compositeKey);
            return await getSubDb(source, sublevel).get(stringToNodeKeyString(nodeKey));
        },

        async readTarget(compositeKey) {
            const { sublevel, nodeKey } = parseCompositeKey(compositeKey);
            return await getSubDb(target, sublevel).get(stringToNodeKeyString(nodeKey));
        },

        equals(sv, tv) {
            return stableStringify(sv) === stableStringify(tv);
        },

        async putTarget(compositeKey, value) {
            const { sublevel, nodeKey } = parseCompositeKey(compositeKey);
            // The cast is safe: putOp on a typed sublevel produces a DatabaseBatchOperation
            // at runtime; the generic type parameter is erased.
            pendingOps.push(/** @type {DatabaseBatchOperation} */ (
                getSubDb(target, sublevel).putOp(stringToNodeKeyString(nodeKey), value)
            ));
            await maybeFlush();
        },

        async deleteTarget(compositeKey) {
            const { sublevel, nodeKey } = parseCompositeKey(compositeKey);
            pendingOps.push(/** @type {DatabaseBatchOperation} */ (
                getSubDb(target, sublevel).delOp(stringToNodeKeyString(nodeKey))
            ));
            await maybeFlush();
        },

        async commit() {
            // Flush all remaining buffered operations.
            while (pendingOps.length > 0) {
                await flushChunk();
            }
        },

        async rollback() {
            // Discard the in-memory buffer.  Already-flushed writes cannot be
            // undone (LevelDB has no rollback); crash-safety is the caller's
            // responsibility.
            pendingOps = [];
        },
    };
}

/**
 * Create an in-memory SchemaStorage that captures writes for later iteration.
 *
 * The returned object implements the same structural interface as SchemaStorage
 * (per-sublevel get/keys, putOp/delOp, and a batch method), so it can be
 * passed to any function that accepts a SchemaStorage, including applyDecisions.
 *
 * Unlike a real SchemaStorage, this implementation does NOT perform version
 * checking in batch() — it is intended purely as a temporary capture store for
 * computing a desired state, not as a durable replica.
 *
 * @returns {SchemaStorage & { _stores: { values: Map<string, unknown>, freshness: Map<string, unknown>, inputs: Map<string, unknown>, revdeps: Map<string, unknown>, counters: Map<string, unknown>, timestamps: Map<string, unknown> } }}
 */
function makeInMemorySchemaStorage() {
    const valuesStore = /** @type {Map<string, unknown>} */ (new Map());
    const freshnessStore = /** @type {Map<string, unknown>} */ (new Map());
    const inputsStore = /** @type {Map<string, unknown>} */ (new Map());
    const revdepsStore = /** @type {Map<string, unknown>} */ (new Map());
    const countersStore = /** @type {Map<string, unknown>} */ (new Map());
    const timestampsStore = /** @type {Map<string, unknown>} */ (new Map());

    /**
     * @param {Map<string, unknown>} store
     * @param {string} sublevelName
     * @returns {import('../root_database').GenericDatabase<unknown>}
     */
    function makeSubstorage(store, sublevelName) {
        return {
            async get(key) {
                return store.get(String(key));
            },
            async put(key, value) {
                store.set(String(key), value);
            },
            async del(key) {
                store.delete(String(key));
            },
            putOp(key, value) {
                return /** @type {*} */ ({ sublevelTag: sublevelName, type: 'put', key: String(key), value });
            },
            delOp(key) {
                return /** @type {*} */ ({ sublevelTag: sublevelName, type: 'del', key: String(key) });
            },
            async *keys() {
                for (const k of store.keys()) {
                    yield /** @type {*} */ (k);
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
     * @param {import('../types').DatabaseBatchOperation[]} ops
     * @returns {Promise<void>}
     */
    async function batch(ops) {
        if (ops.length === 0) return;
        for (const op of ops) {
            const tag = /** @type {*} */ (op).sublevelTag;
            if (typeof tag !== 'string') continue;
            const store = getStore(tag);
            if (store === undefined) continue;
            if (op.type === 'put') {
                store.set(String(op.key), /** @type {*} */ (op).value);
            } else if (op.type === 'del') {
                store.delete(String(op.key));
            }
        }
    }

    return {
        values: /** @type {*} */ (makeSubstorage(valuesStore, 'values')),
        freshness: /** @type {*} */ (makeSubstorage(freshnessStore, 'freshness')),
        inputs: /** @type {*} */ (makeSubstorage(inputsStore, 'inputs')),
        revdeps: /** @type {*} */ (makeSubstorage(revdepsStore, 'revdeps')),
        counters: /** @type {*} */ (makeSubstorage(countersStore, 'counters')),
        timestamps: /** @type {*} */ (makeSubstorage(timestampsStore, 'timestamps')),
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
    stableStringify,
};
