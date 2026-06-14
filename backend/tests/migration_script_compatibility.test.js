/**
 * Regression test: old-format snapshot round-trips through the standalone
 * migration script and produces the expected identifier-native database.
 *
 * The script (scripts/migrate-snapshot-to-identifiers.js) is the single
 * owner of old→identifiers conversion; the backend infrastructure contains
 * zero old-format snapshot conversion logic.  This test ensures the script
 * correctly handles the old-format path layout and produces deterministic
 * output that matches the identifier-native schema.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { migrateSnapshot, decodeArg } = require('../../scripts/migrate-snapshot-to-identifiers');

/**
 * @type {string}
 */
const OLD_VERSION_STRING = '0.0.0-dev-previous';
const MIGRATED_VERSION_STRING = '0.0.0-dev';

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
 * The snapshot format stores all values as JSON text (the same format
 * produced by renderToFilesystem → serializeValue).
 * @param {string} snapshotDir
 * @param {string} relPath - Path relative to snapshotDir (e.g. "rendered/r/values/node_a")
 * @param {unknown} value - The value to JSON.stringify and write.
 */
function writeJson(snapshotDir, relPath, value) {
    const fullPath = path.join(snapshotDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, JSON.stringify(value, null, 2));
}

/**
 * Read a JSON-encoded value from a file inside the snapshot directory.
 * @param {string} snapshotDir
 * @param {string} relPath
 * @returns {unknown}
 */
function readJson(snapshotDir, relPath) {
    const fullPath = path.join(snapshotDir, relPath);
    return JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
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
 * Build an old-format snapshot fixture with a simple two-node dependency graph:
 *   node_a ──> node_b (node_b depends on node_a)
 *
 * Old-format key layout:
 *   - Zero-arg nodes: rendered/r/values/node_a
 *   - Parameterized nodes: rendered/r/values/node_b/arg1
 *
 * No identifiers_keys_map is present — the script must create one.
 *
 * @param {string} snapshotDir
 */
function buildOldFormatFixture(snapshotDir) {
    // _meta/current_replica
    writeJson(snapshotDir, 'rendered/_meta/current_replica', 'x');

    // r/global/version — old-format version string
    writeJson(snapshotDir, 'rendered/r/global/version', OLD_VERSION_STRING);

    // r/values/node_a — zero-arg node
    writeJson(snapshotDir, 'rendered/r/values/node_a', { type: 'a', result: 42 });

    // r/values/node_b/arg1 — parameterized node
    writeJson(snapshotDir, 'rendered/r/values/node_b/arg1', { type: 'b', result: 99, input: 'arg1' });

    // r/values/node_b/arg2 — second parameterization of node_b
    writeJson(snapshotDir, 'rendered/r/values/node_b/arg2', { type: 'b', result: 77, input: 'arg2' });

    // r/freshness/
    writeJson(snapshotDir, 'rendered/r/freshness/node_a', 'up-to-date');
    writeJson(snapshotDir, 'rendered/r/freshness/node_b/arg1', 'up-to-date');
    writeJson(snapshotDir, 'rendered/r/freshness/node_b/arg2', 'up-to-date');

    // r/inputs/ — node_b/arg1 depends on node_a (old-format JSON reference)
    writeJson(snapshotDir, 'rendered/r/inputs/node_a', []);
    writeJson(snapshotDir, 'rendered/r/inputs/node_b/arg1', {
        inputs: ['{"head":"node_a","args":[]}'],
    });
    writeJson(snapshotDir, 'rendered/r/inputs/node_b/arg2', {
        inputs: ['{"head":"node_a","args":[]}'],
    });

    // r/counters/
    writeJson(snapshotDir, 'rendered/r/counters/node_a', 1);
    writeJson(snapshotDir, 'rendered/r/counters/node_b/arg1', 2);
    writeJson(snapshotDir, 'rendered/r/counters/node_b/arg2', 2);

    // r/valid/ — node_a valid lists both node_b variants (old-format JSON references)
    writeJson(snapshotDir, 'rendered/r/valid/node_a', [
        '{"head":"node_b","args":["arg1"]}',
        '{"head":"node_b","args":["arg2"]}',
    ]);

    // r/timestamps/
    const ts = { createdAt: '2024-06-01T00:00:00.000Z', modifiedAt: '2024-06-01T00:00:00.000Z' };
    writeJson(snapshotDir, 'rendered/r/timestamps/node_a', ts);
    writeJson(snapshotDir, 'rendered/r/timestamps/node_b/arg1', ts);
    writeJson(snapshotDir, 'rendered/r/timestamps/node_b/arg2', ts);
}



describe('standalone migration script compatibility', () => {
    /** @type {string} */
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-compat-'));
    });

    afterEach(() => {
        rimrafSync(tmpDir);
    });

    test.each([
        123,
        'abcdefgh',
        'abc123def',
        'ABCdefghi',
        'abcdefghi-',
    ])('migration fails hard for malformed persisted fingerprint %p', async (fingerprint) => {
        buildOldFormatFixture(tmpDir);
        writeJson(tmpDir, 'rendered/r/global/fingerprint', fingerprint);

        await expect(migrateSnapshot(tmpDir)).rejects.toThrow(
            /Invalid fingerprint in snapshot file/
        );
    });

    test('old-format fixture with zero-arg and parameterized nodes round-trips through migration', async () => {
        // Arrange: build old-format fixture
        buildOldFormatFixture(tmpDir);

        // Act: run migration script
        await migrateSnapshot(tmpDir);

        // Verify structural properties:
        // - Each identifier uses the current index-fingerprint format
        // - identifiers_keys_map has exactly 3 entries
        // - All 3 unique keys appear in the map
        // - All old paths are gone

        const mapPath = 'rendered/r/global/identifiers_keys_map';
        const idEntries = readJson(tmpDir, mapPath);
        expect(idEntries.length).toBe(3);

        const expectedKeys = [
            JSON.stringify({ head: 'node_a', args: [] }),
            JSON.stringify({ head: 'node_b', args: ['arg1'] }),
            JSON.stringify({ head: 'node_b', args: ['arg2'] }),
        ];

        const observedKeys = new Set();
        const observedIds = new Set();
        for (const [identifier, nodeKeyJson] of idEntries) {
            expect(typeof identifier).toBe('string');
            expect(identifier).toMatch(/^[0-9a-z]+-[a-z]{9,}$/);
            expect(expectedKeys).toContain(nodeKeyJson);
            observedKeys.add(nodeKeyJson);
            observedIds.add(identifier);
        }
        expect(observedKeys.size).toBe(3);
        expect(observedIds.size).toBe(3);

        // Verify structural properties (no old paths, version normalized)
        expect(fileExists(tmpDir, 'rendered/r/values/node_a')).toBe(false);
        expect(readJson(tmpDir, 'rendered/r/global/version')).toBe(MIGRATED_VERSION_STRING);
    });

    test('migration is idempotent: second run is a no-op', async () => {
        buildOldFormatFixture(tmpDir);
        await migrateSnapshot(tmpDir);

        // Capture the state after first migration
        const mapContent1 = readJson(tmpDir, 'rendered/r/global/identifiers_keys_map');
        const version1 = readJson(tmpDir, 'rendered/r/global/version');

        // Run again
        await migrateSnapshot(tmpDir);

        // State should be unchanged
        const mapContent2 = readJson(tmpDir, 'rendered/r/global/identifiers_keys_map');
        const version2 = readJson(tmpDir, 'rendered/r/global/version');

        expect(mapContent2).toEqual(mapContent1);
        expect(version2).toEqual(version1);

        // Files should not have been removed
        expect(fileExists(tmpDir, 'rendered/r/values/node_a')).toBe(false); // already removed
    });

    test('reference conversion in inputs and valid replaces old-format JSON references with identifiers', async () => {
        buildOldFormatFixture(tmpDir);
        await migrateSnapshot(tmpDir);

        const idEntries = readJson(tmpDir, 'rendered/r/global/identifiers_keys_map');

        /** @type {Map<string, string>} */
        const keyToId = new Map();
        for (const [identifier, nodeKeyJson] of idEntries) {
            keyToId.set(nodeKeyJson, identifier);
        }

        const nodeAId = keyToId.get(JSON.stringify({ head: 'node_a', args: [] }));
        const nodeB1Id = keyToId.get(JSON.stringify({ head: 'node_b', args: ['arg1'] }));

        // Inputs record should reference node_a by identifier
        const inputsRecord = readJson(tmpDir, `rendered/r/inputs/${nodeB1Id}`);
        expect(inputsRecord.inputs).toEqual([nodeAId]);

        // Valid record should reference node_b variants by identifier
        const valid = readJson(tmpDir, `rendered/r/valid/${nodeAId}`);
        expect(Array.isArray(valid)).toBe(true);
        for (const ref of valid) {
            expect(keyToId.has(ref)).toBe(false); // ref should be an identifier, not a key JSON
            expect(typeof ref).toBe('string');
            expect(ref).toMatch(/^[0-9a-z]+-[a-z]{9,}$/);
        }
    });

    test('parameterized node with encoded path segments is decoded correctly', async () => {
        // Create a node with an arg that has special characters
        const nodeKey = { head: 'test_node', args: ['arg/with%2Fslash'] };
        const nodeKeyJson = JSON.stringify(nodeKey);

        writeJson(tmpDir, 'rendered/_meta/current_replica', 'x');
        writeJson(tmpDir, 'rendered/r/global/version', OLD_VERSION_STRING);
        writeJson(tmpDir, `rendered/r/values/test_node/arg%2Fwith%252Fslash`, { result: 'encoded' });
        writeJson(tmpDir, 'rendered/r/freshness/test_node/arg%2Fwith%252Fslash', 'up-to-date');
        writeJson(tmpDir, 'rendered/r/inputs/test_node/arg%2Fwith%252Fslash', {
            inputs: [],
        });
        writeJson(tmpDir, 'rendered/r/counters/test_node/arg%2Fwith%252Fslash', 1);
        writeJson(tmpDir, 'rendered/r/timestamps/test_node/arg%2Fwith%252Fslash', {
            createdAt: '2024-06-01T00:00:00.000Z',
            modifiedAt: '2024-06-01T00:00:00.000Z',
        });

        await migrateSnapshot(tmpDir);

        const idEntries = readJson(tmpDir, 'rendered/r/global/identifiers_keys_map');
        const keyToId = new Map();
        for (const [identifier, nodeKeyJson] of idEntries) {
            keyToId.set(nodeKeyJson, identifier);
        }

        const identifier = keyToId.get(nodeKeyJson);
        expect(identifier).toBeDefined();
        expect(identifier).toMatch(/^[0-9a-z]+-[a-z]{9,}$/);

        // Value should be preserved
        const value = readJson(tmpDir, `rendered/r/values/${identifier}`);
        expect(value).toEqual({ result: 'encoded' });
    });

    test('empty old-format snapshot passes through migration without error', async () => {
        // Minimal: just _meta/current_replica and r/global/version
        writeJson(tmpDir, 'rendered/_meta/current_replica', 'x');
        writeJson(tmpDir, 'rendered/r/global/version', OLD_VERSION_STRING);

        await migrateSnapshot(tmpDir);

        // Should not crash. identifiers_keys_map should exist (empty array).
        const idEntries = readJson(tmpDir, 'rendered/r/global/identifiers_keys_map');
        expect(idEntries).toEqual([]);

        // Version should be normalized
        const version = readJson(tmpDir, 'rendered/r/global/version');
        expect(version).toBe(MIGRATED_VERSION_STRING);
    });

    // ── decodeArg unit tests ───────────────────────────────────────────────

    describe('decodeArg formats old-encoded arguments correctly', () => {
        test('plain string is returned as-is', () => {
            expect(decodeArg('hello')).toBe('hello');
        });

        test('empty string is returned as-is', () => {
            expect(decodeArg('')).toBe('');
        });

        test('number argument (tilde prefix) is parsed as number', () => {
            expect(decodeArg('~42')).toBe(42);
        });

        test('negative number argument is parsed correctly', () => {
            expect(decodeArg('~-3')).toBe(-3);
        });

        test('float argument is parsed as number', () => {
            expect(decodeArg('~3.14')).toBe(3.14);
        });

        test('boolean true argument is parsed as boolean true', () => {
            expect(decodeArg('~true')).toBe(true);
        });

        test('boolean false argument is parsed as boolean false', () => {
            expect(decodeArg('~false')).toBe(false);
        });

        test('null argument is parsed as null', () => {
            expect(decodeArg('~null')).toBeNull();
        });

        test('array argument is parsed as array', () => {
            expect(decodeArg('~[1,2,3]')).toEqual([1, 2, 3]);
        });

        test('object argument is parsed as object', () => {
            expect(decodeArg('~{"a":1}')).toEqual({ a: 1 });
        });

        test('string beginning with tilde is unescaped (~~ → ~)', () => {
            expect(decodeArg('~~abc')).toBe('~abc');
        });

        test('double-tilde string with extra content is unescaped correctly', () => {
            expect(decodeArg('~~tilde')).toBe('~tilde');
        });

        test('string with only double-tilde is just a single tilde', () => {
            expect(decodeArg('~~')).toBe('~');
        });
    });

    // ── Non-string argument migration tests ────────────────────────────────

    describe('old-format snapshot with non-string arguments migrates correctly', () => {
        /**
         * Build a single-node old-format fixture with the given arg value and path suffix.
         * @param {string} snapshotDir
         * @param {string} head
         * @param {unknown} argValue - The semantic arg value (used for expected key).
         * @param {string} pathSuffix - The filesystem path segment (after percent-decoding, used as the raw segment).
         */
        function buildSingleNodeFixture(snapshotDir, head, argValue, pathSuffix) {
            writeJson(snapshotDir, 'rendered/_meta/current_replica', 'x');
            writeJson(snapshotDir, 'rendered/r/global/version', OLD_VERSION_STRING);
            writeJson(snapshotDir, `rendered/r/values/${head}/${pathSuffix}`, { result: 'value' });
            writeJson(snapshotDir, `rendered/r/freshness/${head}/${pathSuffix}`, 'up-to-date');
            writeJson(snapshotDir, `rendered/r/inputs/${head}/${pathSuffix}`, []);
            writeJson(snapshotDir, `rendered/r/counters/${head}/${pathSuffix}`, 1);
            writeJson(snapshotDir, `rendered/r/timestamps/${head}/${pathSuffix}`, {
                createdAt: '2024-06-01T00:00:00.000Z',
                modifiedAt: '2024-06-01T00:00:00.000Z',
            });
        }

        test('number argument is recovered as number in identifiers_keys_map', async () => {
            buildSingleNodeFixture(tmpDir, 'item', 42, '~42');
            await migrateSnapshot(tmpDir);

            const idEntries = readJson(tmpDir, 'rendered/r/global/identifiers_keys_map');
            const keys = idEntries.map(([, keyJson]) => JSON.parse(keyJson));
            expect(keys).toEqual([{ head: 'item', args: [42] }]);
        });

        test('negative number argument is recovered correctly', async () => {
            buildSingleNodeFixture(tmpDir, 'temp', -5, '~-5');
            await migrateSnapshot(tmpDir);

            const idEntries = readJson(tmpDir, 'rendered/r/global/identifiers_keys_map');
            const keys = idEntries.map(([, keyJson]) => JSON.parse(keyJson));
            expect(keys).toEqual([{ head: 'temp', args: [-5] }]);
        });

        test('boolean true argument is recovered as boolean', async () => {
            buildSingleNodeFixture(tmpDir, 'flag', true, '~true');
            await migrateSnapshot(tmpDir);

            const idEntries = readJson(tmpDir, 'rendered/r/global/identifiers_keys_map');
            const keys = idEntries.map(([, keyJson]) => JSON.parse(keyJson));
            expect(keys).toEqual([{ head: 'flag', args: [true] }]);
        });

        test('boolean false argument is recovered as boolean', async () => {
            buildSingleNodeFixture(tmpDir, 'flag', false, '~false');
            await migrateSnapshot(tmpDir);

            const idEntries = readJson(tmpDir, 'rendered/r/global/identifiers_keys_map');
            const keys = idEntries.map(([, keyJson]) => JSON.parse(keyJson));
            expect(keys).toEqual([{ head: 'flag', args: [false] }]);
        });

        test('null argument is recovered as null', async () => {
            buildSingleNodeFixture(tmpDir, 'optional', null, '~null');
            await migrateSnapshot(tmpDir);

            const idEntries = readJson(tmpDir, 'rendered/r/global/identifiers_keys_map');
            const keys = idEntries.map(([, keyJson]) => JSON.parse(keyJson));
            expect(keys).toEqual([{ head: 'optional', args: [null] }]);
        });

        test('string argument beginning with tilde is recovered correctly (~~ → ~)', async () => {
            buildSingleNodeFixture(tmpDir, 'label', '~abc', '~~abc');
            await migrateSnapshot(tmpDir);

            const idEntries = readJson(tmpDir, 'rendered/r/global/identifiers_keys_map');
            const keys = idEntries.map(([, keyJson]) => JSON.parse(keyJson));
            expect(keys).toEqual([{ head: 'label', args: ['~abc'] }]);
        });

        test('argument whose value is just a tilde is recovered correctly (~~ → ~)', async () => {
            buildSingleNodeFixture(tmpDir, 'item', '~', '~~');
            await migrateSnapshot(tmpDir);

            const idEntries = readJson(tmpDir, 'rendered/r/global/identifiers_keys_map');
            const keys = idEntries.map(([, keyJson]) => JSON.parse(keyJson));
            expect(keys).toEqual([{ head: 'item', args: ['~'] }]);
        });

        test('array argument is recovered as array', async () => {
            // Array in old-format: ~ followed by JSON.  No percent-encoding
            // needed because [ , ] are safe in filenames on all platforms.
            buildSingleNodeFixture(tmpDir, 'list', [1, 2, 3], '~[1,2,3]');
            await migrateSnapshot(tmpDir);

            const idEntries = readJson(tmpDir, 'rendered/r/global/identifiers_keys_map');
            const keys = idEntries.map(([, keyJson]) => JSON.parse(keyJson));
            expect(keys).toEqual([{ head: 'list', args: [[1, 2, 3]] }]);
        });

        test('object argument is recovered as object', async () => {
            // Object in old-format: ~ followed by JSON.  Curly braces and
            // double quotes are safe in filenames on common filesystems (ext4,
            // btrfs, xfs, APFS, NTFS) so they are stored as-is without
            // percent-encoding by encodeSegment.
            buildSingleNodeFixture(tmpDir, 'cfg', { a: 1 }, '~{"a":1}');
            await migrateSnapshot(tmpDir);

            const idEntries = readJson(tmpDir, 'rendered/r/global/identifiers_keys_map');
            const keys = idEntries.map(([, keyJson]) => JSON.parse(keyJson));
            expect(keys).toEqual([{ head: 'cfg', args: [{ a: 1 }] }]);
        });

        test('plain string argument is unaffected by new decoding', async () => {
            buildSingleNodeFixture(tmpDir, 'greeting', 'hello', 'hello');
            await migrateSnapshot(tmpDir);

            const idEntries = readJson(tmpDir, 'rendered/r/global/identifiers_keys_map');
            const keys = idEntries.map(([, keyJson]) => JSON.parse(keyJson));
            expect(keys).toEqual([{ head: 'greeting', args: ['hello'] }]);
        });
    });
});
