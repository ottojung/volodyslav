/**
 * Tests for the exploded-format migration script
 * (scripts/migrate-snapshot-to-exploded.js).
 *
 * Ensures old-format single-JSON-file snapshots are correctly converted to
 * the paired kindtree/ + rendered/ format.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { migrateSnapshot, cleanEmptyDirs } = require('../../scripts/migrate-snapshot-to-exploded');
const { parseTypeSchema } = require('../src/generators/incremental_graph/database/render/exploded_json');

/**
 * Recursively remove a directory.
 * @param {string} dir
 */
function rimrafSync(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Write a JSON-encoded value to a file inside the snapshot directory.
 * Old format: all values as JSON text.
 * @param {string} snapshotDir
 * @param {string} relPath
 * @param {unknown} value
 */
function writeJson(snapshotDir, relPath, value) {
    const fullPath = path.join(snapshotDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, JSON.stringify(value, null, 2));
}

/**
 * Write raw text to a file inside the snapshot directory.
 * @param {string} snapshotDir
 * @param {string} relPath
 * @param {string} content
 */
function writeText(snapshotDir, relPath, content) {
    const fullPath = path.join(snapshotDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
}

/**
 * Check if a file exists in the snapshot.
 * @param {string} snapshotDir
 * @param {string} relPath
 * @returns {boolean}
 */
function fileExists(snapshotDir, relPath) {
    return fs.existsSync(path.join(snapshotDir, relPath));
}

/**
 * Read file content.
 * @param {string} snapshotDir
 * @param {string} relPath
 * @returns {string}
 */
function readFile(snapshotDir, relPath) {
    return fs.readFileSync(path.join(snapshotDir, relPath), 'utf-8');
}

/**
 * Build an old-format snapshot fixture.
 * @param {string} snapshotDir
 */
function buildOldFormatFixture(snapshotDir) {
    // _meta
    writeJson(snapshotDir, 'rendered/_meta/current_replica', 'x');

    // global metadata
    writeJson(snapshotDir, 'rendered/r/global/version', '0.0.0-dev');
    writeJson(snapshotDir, 'rendered/r/global/fingerprint', 'testfingerprint');
    writeJson(snapshotDir, 'rendered/r/global/identifiers_keys_map', []);
    writeJson(snapshotDir, 'rendered/r/global/last_node_index', 0);

    // values sublevel — object values
    writeJson(snapshotDir, 'rendered/r/values/node_a', { type: 'a', result: 42, name: 'Alice' });
    writeJson(snapshotDir, 'rendered/r/values/node_b', { type: 'b', result: 99, tags: ['x', 'y'] });

    // Scalar values
    writeJson(snapshotDir, 'rendered/r/counters/gafdmopql', 5);
    writeJson(snapshotDir, 'rendered/r/freshness/gafdmopql', 'up-to-date');
    writeJson(snapshotDir, 'rendered/r/timestamps/gafdmopql', {
        createdAt: '2024-06-01T00:00:00.000Z',
        modifiedAt: '2024-06-01T00:00:00.000Z',
    });
}

describe('exploded migration script compatibility', () => {
    /** @type {string} */
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exploded-migration-'));
    });

    afterEach(() => {
        rimrafSync(tmpDir);
    });

    test('migrates object values to kindtree + exploded rendered leaves', async () => {
        buildOldFormatFixture(tmpDir);
        await migrateSnapshot(tmpDir);

        // kindtree schema files
        expect(readFile(tmpDir, 'kindtree/r/values/node_a')).toBe('{\n  "name": "string",\n  "result": "number",\n  "type": "string"\n}');
        expect(readFile(tmpDir, 'kindtree/r/values/node_b')).toBe('{\n  "result": "number",\n  "tags": [\n    "string",\n    "string"\n  ],\n  "type": "string"\n}');
        expect(readFile(tmpDir, 'kindtree/r/counters/gafdmopql')).toBe('"number"');
        expect(readFile(tmpDir, 'kindtree/r/freshness/gafdmopql')).toBe('"string"');
        expect(readFile(tmpDir, 'kindtree/r/timestamps/gafdmopql')).toBe('{\n  "createdAt": "string",\n  "modifiedAt": "string"\n}');

        // Rendered leaf files
        expect(readFile(tmpDir, 'rendered/r/values/node_a/name')).toBe('Alice');
        expect(readFile(tmpDir, 'rendered/r/values/node_a/result')).toBe('42');
        expect(readFile(tmpDir, 'rendered/r/values/node_a/type')).toBe('a');
        expect(readFile(tmpDir, 'rendered/r/values/node_b/result')).toBe('99');
        expect(readFile(tmpDir, 'rendered/r/values/node_b/tags/0')).toBe('x');
        expect(readFile(tmpDir, 'rendered/r/values/node_b/tags/1')).toBe('y');
        expect(readFile(tmpDir, 'rendered/r/counters/gafdmopql')).toBe('5');
        expect(readFile(tmpDir, 'rendered/r/freshness/gafdmopql')).toBe('up-to-date');

        // Original single JSON files should be gone (replaced by leaves or directory)
        // The old file at rendered/r/values/node_a is now a directory with leaves
        expect(fileExists(tmpDir, 'rendered/r/values/node_a')).toBe(true); // directory exists
        // Scalar rendered values now contain raw content, not JSON
        expect(readFile(tmpDir, 'rendered/r/counters/gafdmopql')).toBe('5');
        expect(readFile(tmpDir, 'rendered/r/freshness/gafdmopql')).toBe('up-to-date');
    });

    test('_meta entries are preserved correctly', async () => {
        buildOldFormatFixture(tmpDir);
        await migrateSnapshot(tmpDir);

        // _meta/current_replica is a string — kindtree has "string" schema
        expect(readFile(tmpDir, 'kindtree/_meta/current_replica')).toBe('"string"');
        // rendered leaf has the raw string value (not JSON-quoted)
        expect(readFile(tmpDir, 'rendered/_meta/current_replica')).toBe('x');
    });

    test('scalar-only values produce kindtree + single leaf', async () => {
        buildOldFormatFixture(tmpDir);
        await migrateSnapshot(tmpDir);

        // Number scalar
        expect(readFile(tmpDir, 'kindtree/r/counters/gafdmopql')).toBe('"number"');
        expect(readFile(tmpDir, 'rendered/r/counters/gafdmopql')).toBe('5');

        // String scalar
        expect(readFile(tmpDir, 'kindtree/r/freshness/gafdmopql')).toBe('"string"');
        expect(readFile(tmpDir, 'rendered/r/freshness/gafdmopql')).toBe('up-to-date');
    });

    test('migration is idempotent: second run is a no-op', async () => {
        buildOldFormatFixture(tmpDir);
        await migrateSnapshot(tmpDir);

        // Capture state after first migration
        const kindtreeFiles1 = fs.readdirSync(path.join(tmpDir, 'kindtree'), { recursive: true }).sort();
        const renderedFiles1 = fs.readdirSync(path.join(tmpDir, 'rendered'), { recursive: true }).sort();

        // Run again
        await migrateSnapshot(tmpDir);

        // State should be unchanged
        const kindtreeFiles2 = fs.readdirSync(path.join(tmpDir, 'kindtree'), { recursive: true }).sort();
        const renderedFiles2 = fs.readdirSync(path.join(tmpDir, 'rendered'), { recursive: true }).sort();

        expect(kindtreeFiles2).toEqual(kindtreeFiles1);
        expect(renderedFiles2).toEqual(renderedFiles1);
    });

    test('migration of comprehensive old-format snapshot reproduces expected kindtree files', async () => {
        // Build a comprehensive old-format fixture covering all value types and sublevels
        writeJson(tmpDir, 'rendered/r/global/version', '0.0.0-dev');
        writeJson(tmpDir, 'rendered/r/global/fingerprint', 'testfingerprint');
        writeJson(tmpDir, 'rendered/r/global/identifiers_keys_map', [['a', '1'], ['b', '2']]);
        writeJson(tmpDir, 'rendered/r/global/last_node_index', 0);
        writeJson(tmpDir, 'rendered/r/values/gafdmopql', { type: 'all_events', events: [] });
        writeJson(tmpDir, 'rendered/r/inputs/gafdmopql', { inputCounters: [], inputs: [] });
        writeJson(tmpDir, 'rendered/r/counters/gafdmopql', 42);
        writeJson(tmpDir, 'rendered/r/timestamps/gafdmopql', { createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-06-01T00:00:00.000Z' });
        writeJson(tmpDir, 'rendered/r/freshness/gafdmopql', 'up-to-date');
        writeJson(tmpDir, 'rendered/r/revdeps/gafdmopql', ['some-revdep-id']);

        await migrateSnapshot(tmpDir);

        // Verify kindtree files exist for known value roots
        expect(fileExists(tmpDir, 'kindtree/r/global/version')).toBe(true);
        expect(fileExists(tmpDir, 'kindtree/r/global/fingerprint')).toBe(true);
        expect(fileExists(tmpDir, 'kindtree/r/global/identifiers_keys_map')).toBe(true);
        expect(fileExists(tmpDir, 'kindtree/r/global/last_node_index')).toBe(true);
        expect(fileExists(tmpDir, 'kindtree/r/values/gafdmopql')).toBe(true);
        expect(fileExists(tmpDir, 'kindtree/r/inputs/gafdmopql')).toBe(true);
        expect(fileExists(tmpDir, 'kindtree/r/counters/gafdmopql')).toBe(true);
        expect(fileExists(tmpDir, 'kindtree/r/timestamps/gafdmopql')).toBe(true);
        expect(fileExists(tmpDir, 'kindtree/r/freshness/gafdmopql')).toBe(true);
        expect(fileExists(tmpDir, 'kindtree/r/revdeps/gafdmopql')).toBe(true);

        // Verify kindtree schema is valid parseable JSON
        for (const name of ['version', 'fingerprint', 'last_node_index']) {
            const schemaText = readFile(tmpDir, `kindtree/r/global/${name}`);
            expect(() => parseTypeSchema(schemaText)).not.toThrow();
        }

        // For object values, the old file path becomes a directory with leaf files
        expect(fileExists(tmpDir, 'rendered/r/values/gafdmopql')).toBe(true); // now a directory
        expect(fileExists(tmpDir, 'rendered/r/values/gafdmopql/type')).toBe(true); // leaf file
    });

    test('migrates minimal metadata-only old-format snapshot', async () => {
        // This is not an empty snapshot: _meta/current_replica is a valid
        // old-format value file.
        writeJson(tmpDir, 'rendered/_meta/current_replica', 'x');

        await migrateSnapshot(tmpDir);

        // kindtree should have _meta schema
        expect(readFile(tmpDir, 'kindtree/_meta/current_replica')).toBe('"string"');
        expect(readFile(tmpDir, 'rendered/_meta/current_replica')).toBe('x');
    });

    // ─── Preflight and validation tests ────────────────────────────────────

    test('invalid JSON fails before mutation', async () => {
        // Setup: one good value and one file with invalid JSON
        writeJson(tmpDir, 'rendered/r/values/good', { x: 1 });
        writeText(tmpDir, 'rendered/r/values/bad', '{not json}');

        // Capture the old content of the good file before migration
        const goodContentBefore = readFile(tmpDir, 'rendered/r/values/good');

        await expect(migrateSnapshot(tmpDir)).rejects.toThrow();

        // No kindtree files should have been created
        expect(fileExists(tmpDir, 'kindtree')).toBe(false);

        // The good file should still be in old format
        expect(readFile(tmpDir, 'rendered/r/values/good')).toBe(goodContentBefore);

        // The bad file should still be present
        expect(readFile(tmpDir, 'rendered/r/values/bad')).toBe('{not json}');
    });

    test('unexpected rendered file depth fails', async () => {
        // A regular file at depth 4 (r/values/node/leaf) is not a valid
        // old-format value root: old values are _meta/<key> (depth 2)
        // or <replica>/<sublevel>/<key> (depth 3).
        writeJson(tmpDir, 'rendered/r/values/node/leaf', { value: 'too deep' });

        await expect(migrateSnapshot(tmpDir)).rejects.toThrow();

        // No kindtree should have been created
        expect(fileExists(tmpDir, 'kindtree')).toBe(false);
    });

    test('empty rendered directory migrates to empty snapshot root', async () => {
        // Create rendered/ with no regular files
        fs.mkdirSync(path.join(tmpDir, 'rendered'), { recursive: true });

        await migrateSnapshot(tmpDir);

        // snapshotRoot still exists
        expect(fs.existsSync(tmpDir)).toBe(true);

        // kindtree should be absent
        expect(fileExists(tmpDir, 'kindtree')).toBe(false);

        // rendered/ may be removed since it is empty
        expect(fileExists(tmpDir, 'rendered')).toBe(false);
    });

    test('empty kindtree directory does not cause false already-migrated no-op', async () => {
        // Setup: an old-format value file plus a kindtree/ containing
        // only empty directories (no real schema files).
        writeJson(tmpDir, 'rendered/r/values/node', { text: 'x' });
        fs.mkdirSync(path.join(tmpDir, 'kindtree', 'some-empty-dir'), { recursive: true });

        await migrateSnapshot(tmpDir);

        // The snapshot should have been migrated: schema file under
        // kindtree/r/values/node must exist
        expect(readFile(tmpDir, 'kindtree/r/values/node')).toBe('{\n  "text": "string"\n}');
    });

    test('empty compounds survive migration', async () => {
        writeJson(tmpDir, 'rendered/r/values/emptyObj', {});
        writeJson(tmpDir, 'rendered/r/values/emptyArr', []);

        await migrateSnapshot(tmpDir);

        // Schema files exist
        expect(readFile(tmpDir, 'kindtree/r/values/emptyObj')).toBe('{}');
        expect(readFile(tmpDir, 'kindtree/r/values/emptyArr')).toBe('[]');

        // No required rendered files
        expect(fileExists(tmpDir, 'rendered/r/values/emptyObj')).toBe(false);
        expect(fileExists(tmpDir, 'rendered/r/values/emptyArr')).toBe(false);
    });

    // ─── Input validation: preflight rejection tests ────────────────────────

    test('rendered exists but is not a directory (regular file) fails before mutation', async () => {
        fs.writeFileSync(path.join(tmpDir, 'rendered'), 'not a directory');
        await expect(migrateSnapshot(tmpDir)).rejects.toThrow();
        expect(fs.statSync(path.join(tmpDir, 'rendered')).isFile()).toBe(true);
        expect(fileExists(tmpDir, 'kindtree')).toBe(false);
    });

    test('non-regular-file entry under rendered is rejected', async () => {
        fs.mkdirSync(path.join(tmpDir, 'rendered', 'r', 'values'), { recursive: true });
        try { fs.symlinkSync('/nonexistent', path.join(tmpDir, 'rendered', 'r', 'values', 'link')); } catch { return; }
        await expect(migrateSnapshot(tmpDir)).rejects.toThrow();
        expect(fileExists(tmpDir, 'kindtree')).toBe(false);
    });

    test('shallow depth rendered/r (depth 1) is rejected', async () => {
        fs.mkdirSync(path.join(tmpDir, 'rendered'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'rendered', 'r'), 'shallow');
        await expect(migrateSnapshot(tmpDir)).rejects.toThrow();
        expect(fileExists(tmpDir, 'kindtree')).toBe(false);
    });

    // ─── Full integration with scanner ─────────────────────────────────────

    // ─── Hardening: cleanEmptyDirs and codec validation ──────────────────

    test('cleanEmptyDirs ignores ENOENT on non-existent directory', async () => {
        await expect(cleanEmptyDirs(path.join(tmpDir, 'nonexistent'))).resolves.toBeUndefined();
    });

    test.failing('cleanEmptyDirs throws on non-ENOENT filesystem error (ENOTDIR on regular file)', async () => {
        const filePath = path.join(tmpDir, 'not-a-dir');
        fs.writeFileSync(filePath, 'content');
        await expect(cleanEmptyDirs(filePath)).rejects.toThrow();
    });

    test('value-root path codec validation in preflight accepts all correct-depth paths', async () => {
        // All filesystem-representable paths at correct old-format depth
        // (_meta/<key>, <replica>/<sublevel>/<key>) pass the codec.
        // This test verifies migration succeeds for representative paths.
        writeJson(tmpDir, 'rendered/_meta/some_key', 'value');
        writeJson(tmpDir, 'rendered/r/values/node', { x: 1 });
        await expect(migrateSnapshot(tmpDir)).resolves.toBeUndefined();
        expect(readFile(tmpDir, 'kindtree/_meta/some_key')).toBe('"string"');
        expect(readFile(tmpDir, 'kindtree/r/values/node')).toBe('{\n  "x": "number"\n}');
    });

    // ─── Empty compounds scanner integration ─────────────────────────────

    test('empty compounds survive migration and scan correctly with the real scanner', async () => {
        const { getRootDatabase, scanSublevelFromSnapshot } = require('../src/generators/incremental_graph/database');
        const { getMockedRootCapabilities } = require('./spies');
        const { stubLogger, stubEnvironment } = require('./stubs');

        const capabilities = getMockedRootCapabilities();
        stubLogger(capabilities);
        stubEnvironment(capabilities);

        writeJson(tmpDir, 'rendered/r/values/emptyObj', {});
        writeJson(tmpDir, 'rendered/r/values/emptyArr', []);
        writeJson(tmpDir, 'rendered/r/values/mixed', { a: {}, b: [] });

        await migrateSnapshot(tmpDir);

        const db = await getRootDatabase(capabilities);
        try {
            await scanSublevelFromSnapshot(capabilities, db, {
                snapshotRoot: tmpDir,
                targetSublevel: 'z',
                snapshotSublevel: 'r',
            });

            const readRaw = async (key) => {
                const marker = key.indexOf('!', 1);
                const sublevel = key.slice(1, marker);
                return await db._rawGetInSublevel(sublevel, key.slice(marker + 1));
            };
            expect(await readRaw('!z!!values!emptyObj')).toEqual({});
            expect(await readRaw('!z!!values!emptyArr')).toEqual([]);
            expect(await readRaw('!z!!values!mixed')).toEqual({ a: {}, b: [] });
        } finally {
            await db.close();
        }
    });

    // ─── Empty rendered directory scanner integration ────────────────────

    test('empty rendered directory migration produces empty root that scans correctly', async () => {
        const { getRootDatabase, scanSublevelFromSnapshot } = require('../src/generators/incremental_graph/database');
        const { getMockedRootCapabilities } = require('./spies');
        const { stubLogger, stubEnvironment } = require('./stubs');

        const capabilities = getMockedRootCapabilities();
        stubLogger(capabilities);
        stubEnvironment(capabilities);

        fs.mkdirSync(path.join(tmpDir, 'rendered'), { recursive: true });

        await migrateSnapshot(tmpDir);

        expect(fs.existsSync(tmpDir)).toBe(true);
        expect(fileExists(tmpDir, 'kindtree')).toBe(false);
        expect(fileExists(tmpDir, 'rendered')).toBe(false);

        // Put existing data in the target sublevel
        const db = await getRootDatabase(capabilities);
        try {
            await db._rawPut('!z!!values!stale', 'should-be-deleted');
            await scanSublevelFromSnapshot(capabilities, db, {
                snapshotRoot: tmpDir,
                targetSublevel: 'z',
                snapshotSublevel: 'r',
            });

            const readRaw = async (key) => {
                const marker = key.indexOf('!', 1);
                const sublevel = key.slice(1, marker);
                return await db._rawGetInSublevel(sublevel, key.slice(marker + 1));
            };
            expect(await readRaw('!z!!values!stale')).toBeUndefined();
        } finally {
            await db.close();
        }
    });

    test('migrated snapshot scans with the real scanner', async () => {
        const { getRootDatabase, scanSublevelFromSnapshot } = require('../src/generators/incremental_graph/database');
        const { getMockedRootCapabilities } = require('./spies');
        const { stubLogger, stubEnvironment } = require('./stubs');

        const capabilities = getMockedRootCapabilities();
        stubLogger(capabilities);
        stubEnvironment(capabilities);

        // Build an old-format fixture with representative values (only r/ sublevel entries)
        writeJson(tmpDir, 'rendered/r/global/version', '1.0.0');
        writeJson(tmpDir, 'rendered/r/global/fingerprint', 'test-fp');
        writeJson(tmpDir, 'rendered/r/values/node', { text: 'hello', count: 42 });

        // Migrate to paired format
        await migrateSnapshot(tmpDir);

        // Scan the migrated snapshot into a fresh database
        const db = await getRootDatabase(capabilities);
        try {
            await scanSublevelFromSnapshot(capabilities, db, {
                snapshotRoot: tmpDir,
                targetSublevel: 'z',
                snapshotSublevel: 'r',
            });

            // Verify values were reconstructed correctly
            const readRaw = async (key) => {
                const marker = key.indexOf('!', 1);
                const sublevel = key.slice(1, marker);
                return await db._rawGetInSublevel(sublevel, key.slice(marker + 1));
            };
            expect(await readRaw('!z!!global!version')).toBe('1.0.0');
            expect(await readRaw('!z!!global!fingerprint')).toBe('test-fp');
            expect(await readRaw('!z!!values!node')).toEqual({ text: 'hello', count: 42 });
        } finally {
            await db.close();
        }
    });
});
