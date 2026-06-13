/**
 * Tests for the DB-to-DB unification adapter (db_to_db.js).
 *
 * Validates:
 *   1. makeDbToDbAdapter correctly unifies two real SchemaStorages.
 *   2. makeInMemorySchemaStorage captures writes from applyDecisions-like code.
 *   3. Only changed keys are written; unchanged keys are left alone.
 *   4. Keys present in target but absent from source are deleted.
 *   5. The adapter correctly handles all DATA_SUBLEVELS.
 */

const {
    makeDbToDbAdapter,
    makeInMemorySchemaStorage,
    unifyStores,
} = require('../src/generators/incremental_graph/database/unification');

const { nodeIdentifierFromString } = require('../src/generators/incremental_graph/database');

// Stable current-format NodeIdentifiers for the test fingerprint used as test node keys.
const NODE_FOO = nodeIdentifierFromString('1-abcdefghi');
const NODE_BAR = nodeIdentifierFromString('2-abcdefghi');
const NODE_BAZ = nodeIdentifierFromString('3-abcdefghi');
const NODE_K   = nodeIdentifierFromString('4-abcdefghi');
const NODE_N   = nodeIdentifierFromString('5-abcdefghi');
const NODE_S   = nodeIdentifierFromString('6-abcdefghi');

// ---------------------------------------------------------------------------
// makeInMemorySchemaStorage tests
// ---------------------------------------------------------------------------

describe('makeInMemorySchemaStorage', () => {
    test('put / get / keys round-trip for all sublevels', async () => {
        const storage = makeInMemorySchemaStorage();
        const nodeKey = NODE_FOO;

        await storage.values.put(nodeKey, { result: 42 });
        await storage.freshness.put(nodeKey, 'fresh');
        await storage.inputs.put(nodeKey, []);

        expect(await storage.values.get(nodeKey)).toEqual({ result: 42 });
        expect(await storage.freshness.get(nodeKey)).toBe('fresh');

        const keys = [];
        for await (const k of storage.values.keys()) keys.push(k);
        expect(keys).toHaveLength(1);
    });

    test('batch with put ops writes to the correct sublevel', async () => {
        const storage = makeInMemorySchemaStorage();
        const nodeKey = NODE_BAR;

        const ops = [
            storage.freshness.putOp(nodeKey, 'outdated'),
            storage.counters.putOp(nodeKey, 5),
        ];
        await storage.batch(ops);

        expect(await storage.freshness.get(nodeKey)).toBe('outdated');
        expect(await storage.counters.get(nodeKey)).toBe(5);
        // Other sublevels untouched
        expect(await storage.values.get(nodeKey)).toBeUndefined();
    });

    test('batch with del ops deletes from the correct sublevel', async () => {
        const storage = makeInMemorySchemaStorage();
        const nodeKey = NODE_BAZ;
        await storage.values.put(nodeKey, 'to-be-deleted');

        const ops = [storage.values.delOp(nodeKey)];
        await storage.batch(ops);

        expect(await storage.values.get(nodeKey)).toBeUndefined();
    });

    test('empty batch is a no-op', async () => {
        const storage = makeInMemorySchemaStorage();
        await expect(storage.batch([])).resolves.not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// makeDbToDbAdapter tests
// ---------------------------------------------------------------------------

/**
 * Helper: build a minimal SchemaStorage-like object backed by plain Maps.
 * Supports the structural interface needed by makeDbToDbAdapter.
 * @returns {{ storage: object, data: Record<string, Map<string, unknown>>, ops: object[] }}
 */
function makeFakeSchemaStorage() {
    const data = {
        values: new Map(),
        freshness: new Map(),
        global: new Map(),
        inputs: new Map(),
        revdeps: new Map(),
        valid: new Map(),
        counters: new Map(),
        timestamps: new Map(),
    };
    const allOps = [];

    function makeSubDb(name) {
        const store = data[name];
        return {
            async get(key) { return store.get(String(key)); },
            async put(key, value) { store.set(String(key), value); },
            async noFlushPut(key, value) {
                store.set(String(key), value);
            },
            async del(key) {
                store.delete(String(key));
            },
            async noFlushDel(key) {
                store.delete(String(key));
            },
            delOp(key) {
                return { _sublevel: name, type: 'del', key: String(key) };
            },
            async *keys() { for (const k of Array.from(store.keys()).sort()) yield k; },
        };
    }

    const storage = {
        values: makeSubDb('values'),
        freshness: makeSubDb('freshness'),
        global: makeSubDb('global'),
        inputs: makeSubDb('inputs'),
        revdeps: makeSubDb('revdeps'),
        valid: makeSubDb('valid'),
        counters: makeSubDb('counters'),
        timestamps: makeSubDb('timestamps'),
        async batch(ops) {
            for (const op of ops) {
                allOps.push(op);
                const store = data[op._sublevel];
                if (!store) continue;
                if (op.type === 'put') store.set(op.key, op.value);
                else if (op.type === 'del') store.delete(op.key);
            }
        },
    };

    return { storage, data, ops: allOps };
}

describe('makeDbToDbAdapter', () => {
    test('copies all source entries to empty target', async () => {
        const { storage: src } = makeFakeSchemaStorage();
        await src.values.put(NODE_K, { v: 1 });
        await src.freshness.put(NODE_K, 'fresh');
        await src.inputs.put(NODE_K, []);

        const { storage: dst, data: dstData } = makeFakeSchemaStorage();

        await unifyStores(makeDbToDbAdapter(src, dst));

        expect(dstData.values.get(String(NODE_K))).toEqual({ v: 1 });
        expect(dstData.freshness.get(String(NODE_K))).toBe('fresh');
        expect(dstData.inputs.get(String(NODE_K))).toEqual([]);
    });

    test('does not rewrite unchanged entries', async () => {
        const { storage: src } = makeFakeSchemaStorage();
        await src.values.put(NODE_K, { v: 1 });

        const { storage: dst, ops: dstOps } = makeFakeSchemaStorage();
        await dst.values.put(NODE_K, { v: 1 });

        await unifyStores(makeDbToDbAdapter(src, dst));

        const puts = dstOps.filter(o => o.type === 'put');
        expect(puts).toHaveLength(0);
    });

    test('rewrites an entry whose value changed', async () => {
        const { storage: src } = makeFakeSchemaStorage();
        await src.values.put(NODE_K, { v: 2 });

        const { storage: dst, data: dstData } = makeFakeSchemaStorage();
        await dst.values.put(NODE_K, { v: 1 });

        const stats = await unifyStores(makeDbToDbAdapter(src, dst));

        expect(stats.putCount).toBe(1);
        expect(dstData.values.get(String(NODE_K))).toEqual({ v: 2 });
    });

    test('deletes target entries absent from source', async () => {
        const { storage: src } = makeFakeSchemaStorage();

        const { storage: dst, data: dstData } = makeFakeSchemaStorage();
        await dst.values.put(NODE_S, 'old');
        await dst.freshness.put(NODE_S, 'fresh');

        const stats = await unifyStores(makeDbToDbAdapter(src, dst));

        expect(stats.deleteCount).toBe(2);
        expect(dstData.values.has(String(NODE_S))).toBe(false);
        expect(dstData.freshness.has(String(NODE_S))).toBe(false);
    });

    test('covers all data sublevels: values, freshness, global, inputs, revdeps, valid, counters, timestamps', async () => {
        const { storage: src } = makeFakeSchemaStorage();
        const k = NODE_N;
        await src.values.put(k, 'val');
        await src.freshness.put(k, 'fresh');
        await src.global.put('version', '1.0.0');
        await src.inputs.put(k, ['dep1']);
        await src.revdeps.put(k, ['dep1']);
        await src.valid.put(k, ['dep1']);
        await src.counters.put(k, 1);
        await src.timestamps.put(k, { createdAt: 'x', modifiedAt: 'y' });

        const { storage: dst, data: dstData } = makeFakeSchemaStorage();

        const stats = await unifyStores(makeDbToDbAdapter(src, dst));

        expect(stats.putCount).toBe(8);
        expect(dstData.values.get(String(k))).toBe('val');
        expect(dstData.freshness.get(String(k))).toBe('fresh');
        expect(dstData.global.get('version')).toBe('1.0.0');
        expect(dstData.inputs.get(String(k))).toEqual(['dep1']);
        expect(dstData.revdeps.get(String(k))).toEqual(['dep1']);
        expect(dstData.valid.get(String(k))).toEqual(['dep1']);
        expect(dstData.counters.get(String(k))).toBe(1);
        expect(dstData.timestamps.get(String(k))).toEqual({ createdAt: 'x', modifiedAt: 'y' });
    });

    test('idempotent: second unification writes nothing', async () => {
        const { storage: src } = makeFakeSchemaStorage();
        await src.values.put(NODE_K, { x: 1 });

        const { storage: dst, ops: dstOps } = makeFakeSchemaStorage();

        await unifyStores(makeDbToDbAdapter(src, dst));
        const opsAfterFirst = dstOps.length;

        await unifyStores(makeDbToDbAdapter(src, dst));
        const opsAfterSecond = dstOps.length;

        expect(opsAfterSecond).toBe(opsAfterFirst); // no new ops
    });

    test('in-memory source → real target: unification applies desired state', async () => {
        const desired = makeInMemorySchemaStorage();
        const k = NODE_FOO;
        await desired.values.put(k, { computed: true });
        await desired.freshness.put(k, 'fresh');

        const { storage: dst, data: dstData } = makeFakeSchemaStorage();
        // Target starts with a stale entry
        await dst.values.put(String(NODE_S), 'remove-me');

        await unifyStores(makeDbToDbAdapter(desired, dst));

        expect(dstData.values.get(String(k))).toEqual({ computed: true });
        expect(dstData.freshness.get(String(k))).toBe('fresh');
        expect(dstData.values.has(String(NODE_S))).toBe(false);
    });
});
