/**
 * Tests for the filesystem-to-DB unification adapter (fs_to_db.js).
 *
 * Validates:
 *   1. Keys present in the snapshot directory but absent from the database are written.
 *   2. Keys present in the database but absent from the snapshot directory are deleted.
 *   3. Keys whose value is unchanged are not rewritten.
 *   4. Keys whose value changed are updated.
 *   5. Stats (sourceCount, putCount, deleteCount, unchangedCount) are accurate.
 *   6. Only the target sublevel is affected; other sublevels are untouched.
 *   7. The adapter produces the same result as scanFromFilesystem.
 *   8. Running twice (idempotency) writes nothing on the second pass.
 *
 * Note: tests use the "x" sublevel which starts clean in a fresh database.
 * The "_meta" sublevel is avoided because getRootDatabase() auto-populates it
 * with system keys (format, current_replica) which would skew expected counts.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const {
    getRootDatabase,
    renderToFilesystem,
    scanFromFilesystem,
} = require('../src/generators/incremental_graph/database');
const {
    makeFsToDbAdapter,
    unifyStores,
} = require('../src/generators/incremental_graph/database/unification');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unification-fs-to-db-'));
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return { capabilities, tmpDir };
}

async function makeSeededDatabase(capabilities, entries) {
    const db = await getRootDatabase(capabilities);
    for (const [key, value] of entries) {
        await db._rawPut(key, value);
    }
    return db;
}

async function collectRawEntries(db) {
    const map = new Map();
    for await (const [key, value] of db._rawEntries()) {
        map.set(key, value);
    }
    return map;
}

/**
 * Raw DB key for a zero-arg node in the 'x' namespace values sublevel.
 * @type {string}
 */
const X_VALUES_KEY = '!x!!values!nodecachex';

/**
 * File path for the same key within the 'x' inputDir.
 * @type {string}
 */
const X_VALUES_REL = path.join('values', 'nodecachex');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeFsToDbAdapter', () => {
    test('writes snapshot files not yet in the database', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'x-input');
        fs.mkdirSync(path.join(inputDir, 'values'), { recursive: true });
        fs.writeFileSync(
            path.join(inputDir, X_VALUES_REL),
            JSON.stringify({ items: [] }, null, 2)
        );

        const db = await getRootDatabase(capabilities);
        try {
            const adapter = makeFsToDbAdapter(capabilities, db, inputDir, 'x');
            const stats = await unifyStores(adapter);

            expect(stats.putCount).toBe(1);
            expect(stats.deleteCount).toBe(0);
            expect(stats.unchangedCount).toBe(0);
            expect(stats.sourceCount).toBe(1);

            const entries = await collectRawEntries(db);
            expect(entries.get(X_VALUES_KEY)).toEqual({ items: [] });
        } finally {
            await db.close();
        }
    });

    test('deletes database entries absent from the snapshot directory', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'x-input');
        fs.mkdirSync(inputDir, { recursive: true });
        // snapshot is empty (no files)

        const db = await makeSeededDatabase(capabilities, [
            [X_VALUES_KEY, { items: ['stale'] }],
        ]);
        try {
            const adapter = makeFsToDbAdapter(capabilities, db, inputDir, 'x');
            const stats = await unifyStores(adapter);

            expect(stats.deleteCount).toBe(1);
            expect(stats.putCount).toBe(0);

            const entries = await collectRawEntries(db);
            expect(entries.has(X_VALUES_KEY)).toBe(false);
        } finally {
            await db.close();
        }
    });

    test('unchanged entries are not rewritten', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'x-input');
        fs.mkdirSync(path.join(inputDir, 'values'), { recursive: true });
        fs.writeFileSync(
            path.join(inputDir, X_VALUES_REL),
            JSON.stringify({ items: [] }, null, 2)
        );

        const db = await makeSeededDatabase(capabilities, [
            [X_VALUES_KEY, { items: [] }],
        ]);
        try {
            const adapter = makeFsToDbAdapter(capabilities, db, inputDir, 'x');
            const stats = await unifyStores(adapter);

            expect(stats.unchangedCount).toBe(1);
            expect(stats.putCount).toBe(0);
            expect(stats.deleteCount).toBe(0);
        } finally {
            await db.close();
        }
    });

    test('updated value in snapshot rewrites the database entry', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'x-input');
        fs.mkdirSync(path.join(inputDir, 'values'), { recursive: true });
        fs.writeFileSync(
            path.join(inputDir, X_VALUES_REL),
            JSON.stringify({ items: [1, 2, 3] }, null, 2)
        );

        const db = await makeSeededDatabase(capabilities, [
            [X_VALUES_KEY, { items: [] }],
        ]);
        try {
            const adapter = makeFsToDbAdapter(capabilities, db, inputDir, 'x');
            const stats = await unifyStores(adapter);

            expect(stats.putCount).toBe(1);
            expect(stats.unchangedCount).toBe(0);

            const entries = await collectRawEntries(db);
            expect(entries.get(X_VALUES_KEY)).toEqual({ items: [1, 2, 3] });
        } finally {
            await db.close();
        }
    });

    test('only the target sublevel is affected; other sublevels are untouched', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'x-input');
        fs.mkdirSync(path.join(inputDir, 'values'), { recursive: true });
        fs.writeFileSync(
            path.join(inputDir, X_VALUES_REL),
            JSON.stringify({ items: [] }, null, 2)
        );

        // Pre-seed with an entry in the _meta sublevel (different sublevel)
        const db = await getRootDatabase(capabilities);
        // _meta!format and _meta!current_replica already exist; note their presence
        try {
            const entriesBefore = await collectRawEntries(db);
            const metaKeysBefore = [...entriesBefore.keys()].filter(k => k.startsWith('!_meta!'));

            const adapter = makeFsToDbAdapter(capabilities, db, inputDir, 'x');
            await unifyStores(adapter);

            const entriesAfter = await collectRawEntries(db);
            const metaKeysAfter = [...entriesAfter.keys()].filter(k => k.startsWith('!_meta!'));

            // Meta sublevel must be untouched
            expect(metaKeysAfter).toEqual(metaKeysBefore);

            // And the x sublevel entry was written
            expect(entriesAfter.get(X_VALUES_KEY)).toEqual({ items: [] });
        } finally {
            await db.close();
        }
    });

    test('idempotent: second scan writes nothing', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'x-input');
        fs.mkdirSync(path.join(inputDir, 'values'), { recursive: true });
        fs.writeFileSync(
            path.join(inputDir, X_VALUES_REL),
            JSON.stringify({ items: [] }, null, 2)
        );

        const db = await getRootDatabase(capabilities);
        try {
            await unifyStores(makeFsToDbAdapter(capabilities, db, inputDir, 'x'));
            const stats2 = await unifyStores(makeFsToDbAdapter(capabilities, db, inputDir, 'x'));

            expect(stats2.putCount).toBe(0);
            expect(stats2.deleteCount).toBe(0);
            expect(stats2.unchangedCount).toBe(1);
        } finally {
            await db.close();
        }
    });

    test('makeFsToDbAdapter produces the same result as scanFromFilesystem', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();

        // Seed a database and render it to disk
        const db1 = await makeSeededDatabase(capabilities, [
            [X_VALUES_KEY, { items: [1, 2, 3] }],
            ['!x!!freshness!{"head":"all_events","args":[]}', 'fresh'],
        ]);
        const renderDir = path.join(tmpDir, 'render-x');
        await renderToFilesystem(capabilities, db1, renderDir, 'x');
        await db1.close();

        // Scan back using the adapter directly
        const db2 = await getRootDatabase(capabilities);
        const adapter = makeFsToDbAdapter(capabilities, db2, renderDir, 'x');
        await unifyStores(adapter);
        const entriesViaAdapter = await collectRawEntries(db2);
        await db2.close();

        // Scan back using scanFromFilesystem
        const db3 = await getRootDatabase(capabilities);
        await scanFromFilesystem(capabilities, db3, renderDir, 'x');
        const entriesViaScan = await collectRawEntries(db3);
        await db3.close();

        // The 'x' sublevel entries should be identical
        const xViaAdapter = new Map([...entriesViaAdapter].filter(([k]) => k.startsWith('!x!')));
        const xViaScan = new Map([...entriesViaScan].filter(([k]) => k.startsWith('!x!')));
        expect(xViaAdapter).toEqual(xViaScan);
    });
});
