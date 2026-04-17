/**
 * Tests for the DB-to-filesystem unification adapter (db_to_fs.js).
 *
 * Validates:
 *   1. Database entries not yet on disk are written as files.
 *   2. Files on disk absent from the database are deleted.
 *   3. Files whose content is unchanged are not rewritten.
 *   4. Files whose content changed are overwritten.
 *   5. Stats (sourceCount, putCount, deleteCount, unchangedCount) are accurate.
 *   6. Only entries in the target sublevel are rendered; other sublevels are ignored.
 *   7. The adapter produces the same result as renderToFilesystem.
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
    makeDbToFsAdapter,
    unifyStores,
} = require('../src/generators/incremental_graph/database/unification');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unification-db-to-fs-'));
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

/**
 * Collect all files under a directory as { relPath, content } objects.
 * @param {string} dir
 * @returns {Array<{ relPath: string, content: string }>}
 */
function collectFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    const results = [];
    function walk(current) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const abs = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(abs);
            } else {
                results.push({
                    relPath: path.relative(dir, abs).split(path.sep).join('/'),
                    content: fs.readFileSync(abs, 'utf8'),
                });
            }
        }
    }
    walk(dir);
    return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/**
 * Raw DB key for a zero-arg node in the 'x' namespace values sublevel.
 * @type {string}
 */
const X_VALUES_KEY = '!x!!values!{"head":"all_events","args":[]}';

/**
 * Relative file path for the same key within the 'x' outputDir.
 * @type {string}
 */
const X_VALUES_REL = 'values/all_events';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeDbToFsAdapter', () => {
    test('writes database entries as files to an empty output directory', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const outputDir = path.join(tmpDir, 'out-x');
        fs.mkdirSync(outputDir, { recursive: true });

        const db = await makeSeededDatabase(capabilities, [
            [X_VALUES_KEY, { items: [] }],
        ]);
        try {
            const adapter = makeDbToFsAdapter(capabilities, db, outputDir, 'x');
            const stats = await unifyStores(adapter);

            expect(stats.putCount).toBe(1);
            expect(stats.deleteCount).toBe(0);
            expect(stats.sourceCount).toBe(1);

            const files = collectFiles(outputDir);
            expect(files).toHaveLength(1);
            expect(files[0].relPath).toBe(X_VALUES_REL);
            expect(JSON.parse(files[0].content)).toEqual({ items: [] });
        } finally {
            await db.close();
        }
    });

    test('deletes stale files on disk absent from the database', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const outputDir = path.join(tmpDir, 'out-x');
        fs.mkdirSync(path.join(outputDir, 'values'), { recursive: true });
        fs.writeFileSync(
            path.join(outputDir, X_VALUES_REL),
            JSON.stringify({ items: ['stale'] }, null, 2)
        );

        // DB has no 'x' sublevel entries
        const db = await getRootDatabase(capabilities);
        try {
            const adapter = makeDbToFsAdapter(capabilities, db, outputDir, 'x');
            const stats = await unifyStores(adapter);

            expect(stats.deleteCount).toBe(1);
            expect(stats.putCount).toBe(0);
            expect(collectFiles(outputDir)).toHaveLength(0);
        } finally {
            await db.close();
        }
    });

    test('unchanged files are not rewritten', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const outputDir = path.join(tmpDir, 'out-x');
        fs.mkdirSync(path.join(outputDir, 'values'), { recursive: true });
        // Write the same content that serializeValue would produce
        fs.writeFileSync(
            path.join(outputDir, X_VALUES_REL),
            JSON.stringify({ items: [] }, null, 2)
        );

        const db = await makeSeededDatabase(capabilities, [
            [X_VALUES_KEY, { items: [] }],
        ]);
        try {
            const adapter = makeDbToFsAdapter(capabilities, db, outputDir, 'x');
            const stats = await unifyStores(adapter);

            expect(stats.unchangedCount).toBe(1);
            expect(stats.putCount).toBe(0);
            expect(stats.deleteCount).toBe(0);
        } finally {
            await db.close();
        }
    });

    test('changed value in database overwrites the file', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const outputDir = path.join(tmpDir, 'out-x');
        fs.mkdirSync(path.join(outputDir, 'values'), { recursive: true });
        fs.writeFileSync(
            path.join(outputDir, X_VALUES_REL),
            JSON.stringify({ items: [] }, null, 2)
        );

        const db = await makeSeededDatabase(capabilities, [
            [X_VALUES_KEY, { items: [1, 2, 3] }],
        ]);
        try {
            const adapter = makeDbToFsAdapter(capabilities, db, outputDir, 'x');
            const stats = await unifyStores(adapter);

            expect(stats.putCount).toBe(1);
            const files = collectFiles(outputDir);
            expect(JSON.parse(files[0].content)).toEqual({ items: [1, 2, 3] });
        } finally {
            await db.close();
        }
    });

    test('only the target sublevel is rendered; other sublevels are ignored', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const outputDir = path.join(tmpDir, 'out-x');
        fs.mkdirSync(outputDir, { recursive: true });

        // DB has both _meta and x entries; only x should be rendered
        const db = await makeSeededDatabase(capabilities, [
            [X_VALUES_KEY, { items: [] }],
        ]);
        try {
            const adapter = makeDbToFsAdapter(capabilities, db, outputDir, 'x');
            const stats = await unifyStores(adapter);

            expect(stats.sourceCount).toBe(1); // only the 'x' entry, not _meta entries
            const files = collectFiles(outputDir);
            expect(files).toHaveLength(1);
            expect(files[0].relPath).toBe(X_VALUES_REL);
        } finally {
            await db.close();
        }
    });

    test('idempotent: second render writes nothing', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const outputDir = path.join(tmpDir, 'out-x');
        fs.mkdirSync(outputDir, { recursive: true });

        const db = await makeSeededDatabase(capabilities, [
            [X_VALUES_KEY, { items: [] }],
        ]);
        try {
            await unifyStores(makeDbToFsAdapter(capabilities, db, outputDir, 'x'));
            const stats2 = await unifyStores(makeDbToFsAdapter(capabilities, db, outputDir, 'x'));

            expect(stats2.putCount).toBe(0);
            expect(stats2.deleteCount).toBe(0);
            expect(stats2.unchangedCount).toBe(1);
        } finally {
            await db.close();
        }
    });

    test('makeDbToFsAdapter produces the same files as renderToFilesystem', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();

        const db = await makeSeededDatabase(capabilities, [
            [X_VALUES_KEY, { items: [1, 2] }],
            ['!x!!freshness!{"head":"all_events","args":[]}', 'fresh'],
        ]);
        try {
            // Render via high-level function
            const outputDirA = path.join(tmpDir, 'render-a');
            await renderToFilesystem(capabilities, db, outputDirA, 'x');

            // Render via adapter directly (output dir must pre-exist for listTargetKeys)
            const outputDirB = path.join(tmpDir, 'render-b');
            fs.mkdirSync(outputDirB, { recursive: true });
            await unifyStores(makeDbToFsAdapter(capabilities, db, outputDirB, 'x'));

            expect(collectFiles(outputDirA)).toEqual(collectFiles(outputDirB));
        } finally {
            await db.close();
        }
    });

    test('round-trip with scan: render then scan restores original database', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const outputDir = path.join(tmpDir, 'render-x');
        fs.mkdirSync(outputDir, { recursive: true });

        const db1 = await makeSeededDatabase(capabilities, [
            [X_VALUES_KEY, { items: [10] }],
        ]);
        await unifyStores(makeDbToFsAdapter(capabilities, db1, outputDir, 'x'));
        await db1.close();

        const db2 = await getRootDatabase(capabilities);
        try {
            await scanFromFilesystem(capabilities, db2, outputDir, 'x');
            const rawVal = await db2._rawGetInSublevel('x', '!values!{"head":"all_events","args":[]}');
            expect(rawVal).toEqual({ items: [10] });
        } finally {
            await db2.close();
        }
    });
});
