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

const { stringToNodeKeyString } = require('../src/generators/incremental_graph/database/types');

// ---------------------------------------------------------------------------
// makeInMemorySchemaStorage tests
// ---------------------------------------------------------------------------

describe('makeInMemorySchemaStorage', () => {
    test('put / get / keys round-trip for all sublevels', async () => {
        const storage = makeInMemorySchemaStorage();
        const nodeKey = stringToNodeKeyString('{"head":"foo","args":[]}');

        await storage.values.put(nodeKey, { result: 42 });
        await storage.freshness.put(nodeKey, 'fresh');
        await storage.inputs.put(nodeKey, { inputs: [], inputCounters: [] });

        expect(await storage.values.get(nodeKey)).toEqual({ result: 42 });
        expect(await storage.freshness.get(nodeKey)).toBe('fresh');

        const keys = [];
        for await (const k of storage.values.keys()) keys.push(k);
        expect(keys).toHaveLength(1);
    });

    test('batch with put ops writes to the correct sublevel', async () => {
        const storage = makeInMemorySchemaStorage();
        const nodeKey = stringToNodeKeyString('{"head":"bar","args":[]}');

        const ops = [
            storage.freshness.putOp(nodeKey, 'outdated'),
            storage.counters.putOp(nodeKey, { count: 5, seed: 'x' }),
        ];
        await storage.batch(ops);

        expect(await storage.freshness.get(nodeKey)).toBe('outdated');
        expect(await storage.counters.get(nodeKey)).toEqual({ count: 5, seed: 'x' });
        // Other sublevels untouched
        expect(await storage.values.get(nodeKey)).toBeUndefined();
    });

    test('batch with del ops deletes from the correct sublevel', async () => {
        const storage = makeInMemorySchemaStorage();
        const nodeKey = stringToNodeKeyString('{"head":"baz","args":[]}');
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
        inputs: new Map(),
        revdeps: new Map(),
        counters: new Map(),
        timestamps: new Map(),
    };
    const allOps = [];

    function makeSubDb(name) {
        const store = data[name];
        return {
            async get(key) { return store.get(String(key)); },
            async put(key, value) { store.set(String(key), value); },
            async rawPut(key, value) {
                allOps.push({ _sublevel: name, type: 'put', key: String(key), value });
                store.set(String(key), value);
            },
            async del(key) {
                store.delete(String(key));
            },
            async rawDel(key) {
                allOps.push({ _sublevel: name, type: 'del', key: String(key) });
                store.delete(String(key));
            },
            putOp(key, value) {
                return { _sublevel: name, type: 'put', key: String(key), value };
            },
            rawPutOp(key, value) {
                return { _sublevel: name, type: 'put', key: String(key), value };
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
        inputs: makeSubDb('inputs'),
        revdeps: makeSubDb('revdeps'),
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
        await src.values.put('k1', { v: 1 });
        await src.freshness.put('k1', 'fresh');
        await src.inputs.put('k1', { inputs: [], inputCounters: [] });

        const { storage: dst, data: dstData } = makeFakeSchemaStorage();

        await unifyStores(makeDbToDbAdapter(src, dst));

        expect(dstData.values.get('k1')).toEqual({ v: 1 });
        expect(dstData.freshness.get('k1')).toBe('fresh');
        expect(dstData.inputs.get('k1')).toEqual({ inputs: [], inputCounters: [] });
    });

    test('does not rewrite unchanged entries', async () => {
        const { storage: src } = makeFakeSchemaStorage();
        await src.values.put('k1', { v: 1 });

        const { storage: dst, ops: dstOps } = makeFakeSchemaStorage();
        await dst.values.put('k1', { v: 1 });

        await unifyStores(makeDbToDbAdapter(src, dst));

        const puts = dstOps.filter(o => o.type === 'put');
        expect(puts).toHaveLength(0);
    });

    test('rewrites an entry whose value changed', async () => {
        const { storage: src } = makeFakeSchemaStorage();
        await src.values.put('k1', { v: 2 });

        const { storage: dst, data: dstData } = makeFakeSchemaStorage();
        await dst.values.put('k1', { v: 1 });

        const stats = await unifyStores(makeDbToDbAdapter(src, dst));

        expect(stats.putCount).toBe(1);
        expect(dstData.values.get('k1')).toEqual({ v: 2 });
    });

    test('deletes target entries absent from source', async () => {
        const { storage: src } = makeFakeSchemaStorage();

        const { storage: dst, data: dstData } = makeFakeSchemaStorage();
        await dst.values.put('stale', 'old');
        await dst.freshness.put('stale', 'fresh');

        const stats = await unifyStores(makeDbToDbAdapter(src, dst));

        expect(stats.deleteCount).toBe(2);
        expect(dstData.values.has('stale')).toBe(false);
        expect(dstData.freshness.has('stale')).toBe(false);
    });

    test('covers all data sublevels: values, freshness, inputs, revdeps, counters, timestamps', async () => {
        const { storage: src } = makeFakeSchemaStorage();
        const k = 'node-key';
        await src.values.put(k, 'val');
        await src.freshness.put(k, 'fresh');
        await src.inputs.put(k, { inputs: [], inputCounters: [] });
        await src.revdeps.put(k, ['dep1']);
        await src.counters.put(k, { count: 1, seed: 's' });
        await src.timestamps.put(k, { createdAt: 'x', modifiedAt: 'y' });

        const { storage: dst, data: dstData } = makeFakeSchemaStorage();

        const stats = await unifyStores(makeDbToDbAdapter(src, dst));

        expect(stats.putCount).toBe(6);
        expect(dstData.values.get(k)).toBe('val');
        expect(dstData.freshness.get(k)).toBe('fresh');
        expect(dstData.inputs.get(k)).toEqual({ inputs: [], inputCounters: [] });
        expect(dstData.revdeps.get(k)).toEqual(['dep1']);
        expect(dstData.counters.get(k)).toEqual({ count: 1, seed: 's' });
        expect(dstData.timestamps.get(k)).toEqual({ createdAt: 'x', modifiedAt: 'y' });
    });

    test('idempotent: second unification writes nothing', async () => {
        const { storage: src } = makeFakeSchemaStorage();
        await src.values.put('k', { x: 1 });

        const { storage: dst, ops: dstOps } = makeFakeSchemaStorage();

        await unifyStores(makeDbToDbAdapter(src, dst));
        const opsAfterFirst = dstOps.length;

        await unifyStores(makeDbToDbAdapter(src, dst));
        const opsAfterSecond = dstOps.length;

        expect(opsAfterSecond).toBe(opsAfterFirst); // no new ops
    });

    test('in-memory source → real target: unification applies desired state', async () => {
        const desired = makeInMemorySchemaStorage();
        const k = stringToNodeKeyString('{"head":"foo","args":[]}');
        await desired.values.put(k, { computed: true });
        await desired.freshness.put(k, 'fresh');

        const { storage: dst, data: dstData } = makeFakeSchemaStorage();
        // Target starts with a stale entry
        await dst.values.put('stale', 'remove-me');

        await unifyStores(makeDbToDbAdapter(desired, dst));

        expect(dstData.values.get(String(k))).toEqual({ computed: true });
        expect(dstData.freshness.get(String(k))).toBe('fresh');
        expect(dstData.values.has('stale')).toBe(false);
    });
});
