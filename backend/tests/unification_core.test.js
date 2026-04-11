/**
 * Tests for the core gentle-unification engine (unification/core.js).
 *
 * Covers core synchronization scenarios and failure handling, including:
 *   1. No-op convergence: running on already-identical stores writes nothing.
 *   2. Pure put: source has keys absent from target → all written.
 *   3. Pure delete: target has keys absent from source → all deleted.
 *   4. Mixed patch: some keys added, some removed, some unchanged.
 *   5. Value update: key exists in both but values differ → put.
 *   6. Error propagation: each phase error wraps cause and has correct type.
 *   7. Idempotency: running twice yields zero writes on second run.
 *   8. Stats accuracy: sourceCount, targetCount, putCount, deleteCount, unchangedCount.
 */

const {
    unifyStores,
    UnificationListError,
    isUnificationListError,
    isUnificationReadError,
    isUnificationWriteError,
    isUnificationDeleteError,
    isUnificationCommitError,
} = require('../src/generators/incremental_graph/database/unification');

// ---------------------------------------------------------------------------
// Minimal in-memory adapter builder
// ---------------------------------------------------------------------------

/**
 * Build a simple in-memory adapter backed by two Maps.
 * @param {Map<string, unknown>} sourceMap
 * @param {Map<string, unknown>} targetMap
 * @returns {{ adapter: import('../src/generators/incremental_graph/database/unification').UnificationAdapter, ops: Array<{op: string, key: string, value?: unknown}> }}
 */
function makeMapAdapter(sourceMap, targetMap) {
    /** @type {Array<{op: string, key: string, value?: unknown}>} */
    const ops = [];

    const adapter = {
        async *listSourceKeys() {
            for (const key of [...sourceMap.keys()].sort()) yield key;
        },
        async *listTargetKeys() {
            for (const key of [...targetMap.keys()].sort()) yield key;
        },
        async readSource(key) {
            return sourceMap.get(key);
        },
        async readTarget(key) {
            return targetMap.get(key);
        },
        equals(sv, tv) {
            return JSON.stringify(sv) === JSON.stringify(tv);
        },
        async putTarget(key, value) {
            ops.push({ op: 'put', key, value });
            targetMap.set(key, value);
        },
        async deleteTarget(key) {
            ops.push({ op: 'del', key });
            targetMap.delete(key);
        },
    };

    return { adapter, ops };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('unifyStores', () => {
    test('no-op convergence: identical stores produce zero writes', async () => {
        const data = new Map([['a', 1], ['b', 2], ['c', 3]]);
        const source = new Map(data);
        const target = new Map(data);
        const { adapter, ops } = makeMapAdapter(source, target);

        const stats = await unifyStores(adapter);

        expect(ops).toHaveLength(0);
        expect(stats.putCount).toBe(0);
        expect(stats.deleteCount).toBe(0);
        expect(stats.unchangedCount).toBe(3);
        expect(stats.sourceCount).toBe(3);
        expect(stats.targetCount).toBe(3);
    });

    test('pure put: all source keys written to empty target', async () => {
        const source = new Map([['x', 10], ['y', 20]]);
        const target = new Map();
        const { adapter } = makeMapAdapter(source, target);

        const stats = await unifyStores(adapter);

        expect(stats.putCount).toBe(2);
        expect(stats.deleteCount).toBe(0);
        expect(stats.unchangedCount).toBe(0);
        expect(stats.sourceCount).toBe(2);
        expect(stats.targetCount).toBe(0);
        expect(target.get('x')).toBe(10);
        expect(target.get('y')).toBe(20);
    });

    test('pure delete: all target keys absent from empty source are deleted', async () => {
        const source = new Map();
        const target = new Map([['p', 'old'], ['q', 'also-old']]);
        const { adapter } = makeMapAdapter(source, target);

        const stats = await unifyStores(adapter);

        expect(stats.putCount).toBe(0);
        expect(stats.deleteCount).toBe(2);
        expect(stats.unchangedCount).toBe(0);
        expect(stats.sourceCount).toBe(0);
        expect(stats.targetCount).toBe(2);
        expect(target.size).toBe(0);
    });

    test('mixed patch: adds new keys, deletes stale keys, keeps unchanged keys', async () => {
        const source = new Map([['keep', 'same'], ['add', 'new']]);
        const target = new Map([['keep', 'same'], ['stale', 'remove-me']]);
        const { adapter } = makeMapAdapter(source, target);

        const stats = await unifyStores(adapter);

        expect(stats.putCount).toBe(1);    // 'add'
        expect(stats.deleteCount).toBe(1); // 'stale'
        expect(stats.unchangedCount).toBe(1); // 'keep'
        expect(target.has('add')).toBe(true);
        expect(target.has('stale')).toBe(false);
        expect(target.get('keep')).toBe('same');
    });

    test('value update: same key but different value triggers a put', async () => {
        const source = new Map([['k', { v: 2 }]]);
        const target = new Map([['k', { v: 1 }]]);
        const { adapter } = makeMapAdapter(source, target);

        const stats = await unifyStores(adapter);

        expect(stats.putCount).toBe(1);
        expect(stats.unchangedCount).toBe(0);
        expect(target.get('k')).toEqual({ v: 2 });
    });

    test('idempotency: second run on same stores writes nothing', async () => {
        const source = new Map([['a', 1], ['b', 2]]);
        const target = new Map([['c', 3]]);
        const { adapter: a1 } = makeMapAdapter(source, target);
        await unifyStores(a1);

        // target is now identical to source; run again
        const { adapter: a2, ops: ops2 } = makeMapAdapter(source, target);
        const stats2 = await unifyStores(a2);

        expect(ops2).toHaveLength(0);
        expect(stats2.putCount).toBe(0);
        expect(stats2.deleteCount).toBe(0);
    });

    test('commit is called after phase 2 and 3', async () => {
        const source = new Map([['x', 1]]);
        const target = new Map();
        let commitCalled = false;
        const { adapter } = makeMapAdapter(source, target);
        adapter.commit = async () => { commitCalled = true; };

        await unifyStores(adapter);

        expect(commitCalled).toBe(true);
    });

    test('begin is called before any reads or writes', async () => {
        const callOrder = [];
        const source = new Map([['k', 1]]);
        const target = new Map();
        const { adapter } = makeMapAdapter(source, target);
        adapter.begin = async () => { callOrder.push('begin'); };
        const origListSource = adapter.listSourceKeys.bind(adapter);
        adapter.listSourceKeys = async function* () {
            callOrder.push('listSource');
            yield* origListSource();
        };

        await unifyStores(adapter);

        expect(callOrder[0]).toBe('begin');
        expect(callOrder[1]).toBe('listSource');
    });

    // ── Error propagation ────────────────────────────────────────────────────

    test('listSourceKeys error → UnificationListError(source)', async () => {
        const cause = new Error('list source boom');
        const adapter = {
            listSourceKeys: async function* () { yield* []; throw cause; },
            listTargetKeys: async function* () { yield* []; },
            readSource: async () => undefined,
            readTarget: async () => undefined,
            equals: () => false,
            putTarget: async () => {},
            deleteTarget: async () => {},
        };

        await expect(unifyStores(adapter)).rejects.toBeInstanceOf(UnificationListError);
        let thrown;
        try { await unifyStores(adapter); } catch (e) { thrown = e; }
        expect(isUnificationListError(thrown)).toBe(true);
        expect(thrown.side).toBe('source');
        expect(thrown.cause).toBe(cause);
    });

    test('listTargetKeys error → UnificationListError(target)', async () => {
        const cause = new Error('list target boom');
        const adapter = {
            listSourceKeys: async function* () { yield* []; },
            listTargetKeys: async function* () { yield* []; throw cause; },
            readSource: async () => undefined,
            readTarget: async () => undefined,
            equals: () => false,
            putTarget: async () => {},
            deleteTarget: async () => {},
        };

        let thrown;
        try { await unifyStores(adapter); } catch (e) { thrown = e; }
        expect(isUnificationListError(thrown)).toBe(true);
        expect(thrown.side).toBe('target');
        expect(thrown.cause).toBe(cause);
    });

    test('readSource error → UnificationReadError(source)', async () => {
        const cause = new Error('read source boom');
        const adapter = {
            listSourceKeys: async function* () { yield 'k'; },
            listTargetKeys: async function* () { yield* []; },
            readSource: async () => { throw cause; },
            readTarget: async () => undefined,
            equals: () => false,
            putTarget: async () => {},
            deleteTarget: async () => {},
        };

        let thrown;
        try { await unifyStores(adapter); } catch (e) { thrown = e; }
        expect(isUnificationReadError(thrown)).toBe(true);
        expect(thrown.side).toBe('source');
        expect(thrown.key).toBe('k');
        expect(thrown.cause).toBe(cause);
    });

    test('readTarget error → UnificationReadError(target)', async () => {
        const cause = new Error('read target boom');
        const adapter = {
            listSourceKeys: async function* () { yield 'k'; },
            listTargetKeys: async function* () { yield 'k'; },
            readSource: async () => 42,
            readTarget: async () => { throw cause; },
            equals: () => false,
            putTarget: async () => {},
            deleteTarget: async () => {},
        };

        let thrown;
        try { await unifyStores(adapter); } catch (e) { thrown = e; }
        expect(isUnificationReadError(thrown)).toBe(true);
        expect(thrown.side).toBe('target');
        expect(thrown.cause).toBe(cause);
    });

    test('putTarget error → UnificationWriteError', async () => {
        const cause = new Error('write boom');
        const adapter = {
            listSourceKeys: async function* () { yield 'k'; },
            listTargetKeys: async function* () { yield* []; },
            readSource: async () => 1,
            readTarget: async () => undefined,
            equals: () => false,
            putTarget: async () => { throw cause; },
            deleteTarget: async () => {},
        };

        let thrown;
        try { await unifyStores(adapter); } catch (e) { thrown = e; }
        expect(isUnificationWriteError(thrown)).toBe(true);
        expect(thrown.key).toBe('k');
        expect(thrown.cause).toBe(cause);
    });

    test('deleteTarget error → UnificationDeleteError', async () => {
        const cause = new Error('delete boom');
        const adapter = {
            listSourceKeys: async function* () { yield* []; },
            listTargetKeys: async function* () { yield 'k'; },
            readSource: async () => undefined,
            readTarget: async () => 1,
            equals: () => false,
            putTarget: async () => {},
            deleteTarget: async () => { throw cause; },
        };

        let thrown;
        try { await unifyStores(adapter); } catch (e) { thrown = e; }
        expect(isUnificationDeleteError(thrown)).toBe(true);
        expect(thrown.key).toBe('k');
        expect(thrown.cause).toBe(cause);
    });

    test('commit error → UnificationCommitError', async () => {
        const cause = new Error('commit boom');
        const source = new Map([['a', 1]]);
        const target = new Map();
        const { adapter } = makeMapAdapter(source, target);
        adapter.commit = async () => { throw cause; };

        let thrown;
        try { await unifyStores(adapter); } catch (e) { thrown = e; }
        expect(isUnificationCommitError(thrown)).toBe(true);
        expect(thrown.cause).toBe(cause);
    });

    test('rollback is called on error after begin', async () => {
        const cause = new Error('list boom');
        let rollbackCalled = false;
        const adapter = {
            begin: async () => {},
            listSourceKeys: async function* () { yield* []; throw cause; },
            listTargetKeys: async function* () { yield* []; },
            readSource: async () => undefined,
            readTarget: async () => undefined,
            equals: () => false,
            putTarget: async () => {},
            deleteTarget: async () => {},
            rollback: async () => { rollbackCalled = true; },
        };

        try { await unifyStores(adapter); } catch (_) { /* expected */ }
        expect(rollbackCalled).toBe(true);
    });

    test('error type guards return false for non-matching types', () => {
        const err = new Error('generic');
        expect(isUnificationListError(err)).toBe(false);
        expect(isUnificationReadError(err)).toBe(false);
        expect(isUnificationWriteError(err)).toBe(false);
        expect(isUnificationDeleteError(err)).toBe(false);
        expect(isUnificationCommitError(err)).toBe(false);

        expect(isUnificationListError(null)).toBe(false);
        expect(isUnificationListError(undefined)).toBe(false);
    });
});
