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

const { migrateSnapshot } = require('../../scripts/migrate-snapshot-to-exploded');
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

    test('empty old-format snapshot passes through without error', async () => {
        // Just _meta/current_replica
        writeJson(tmpDir, 'rendered/_meta/current_replica', 'x');

        await migrateSnapshot(tmpDir);

        // kindtree should have _meta schema
        expect(readFile(tmpDir, 'kindtree/_meta/current_replica')).toBe('"string"');
        expect(readFile(tmpDir, 'rendered/_meta/current_replica')).toBe('x');
    });
});
