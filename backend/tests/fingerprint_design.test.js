/**
 * Tests for the r/global/fingerprint design.
 *
 * Verifies that:
 *   1. Fresh database initialization writes all three global metadata keys.
 *   2. Rendered snapshot contains r/global/fingerprint, not _meta/fingerprint.
 *   3. First-boot restore imports snapshot fingerprint.
 *   4. Reset into existing live DB preserves pre-import local fingerprint.
 *   5. Sync merge preserves local fingerprint (host fingerprint not adopted).
 *   6. Metadata-only host allocation metadata is ignored.
 *   7. Restart preserves fingerprint and last_node_index.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const {
    IDENTIFIERS_KEY,
    LAST_NODE_INDEX_KEY,
    getRootDatabase,
    renderSublevelToSnapshot,
    scanSublevelFromSnapshot,
    nodeIdentifierFromString,
    makeIdentifierLookup,
    serializeIdentifierLookup,
    isValidFingerprint,
} = require('../src/generators/incremental_graph/database');
const {
    mergeHostIntoReplica,
} = require('../src/generators/incremental_graph/database/sync_merge');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');

jest.setTimeout(20000);

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fingerprint-test-'));
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return { capabilities, tmpDir };
}

function cleanup(tmpDir) {
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

function collectFiles(dir, base) {
    const root = base ?? dir;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            result.push(...collectFiles(abs, root));
        } else {
            const relPath = path.relative(root, abs).split(path.sep).join('/');
            const content = fs.readFileSync(abs, 'utf8');
            result.push({ relPath, content });
        }
    }
    return result;
}

function makeLogger() {
    return { logInfo: jest.fn(), logDebug: jest.fn(), logWarning: jest.fn(), logError: jest.fn() };
}

const NODE_A = nodeIdentifierFromString('1-abcdefghi');
const HOST_NODE_A = nodeIdentifierFromString('1-remotehostfingerprint');
const TS1 = '2024-01-01T00:00:01.000Z';

describe('fingerprint design', () => {
    let db;

    test.each([
        'abcdefghi',
        'abcdefghijklmnop',
    ])('accepts valid fingerprint %s', (fingerprint) => {
        expect(isValidFingerprint(fingerprint)).toBe(true);
    });

    test.each([
        undefined,
        123,
        'abcdefgh',
        'abc123def',
        'ABCdefghi',
        'abcdefghi-',
    ])('rejects malformed fingerprint %p', (fingerprint) => {
        expect(isValidFingerprint(fingerprint)).toBe(false);
    });

    afterEach(async () => {
        if (db) {
            try { await db.close(); } catch (_) { /* already closed */ }
            db = undefined;
        }
    });

    // ── 1. Fresh database initialization ──────────────────────────────────

    test('fresh database initializes fingerprint, identifiers_keys_map, and last_node_index', async () => {
        const { capabilities, tmpDir } = getTestCapabilities();
        try {
            db = await getRootDatabase(capabilities);

            const fingerprint = db.getFingerprint();
            expect(typeof fingerprint).toBe('string');
            expect(fingerprint.length).toBeGreaterThanOrEqual(9);
            expect(fingerprint).toMatch(/^[a-z]{9,}$/);

            const global = db.getSchemaStorage().global;
            const storedFingerprint = await global.get('fingerprint');
            expect(storedFingerprint).toBe(fingerprint);

            const identifiersMap = await global.get(IDENTIFIERS_KEY);
            expect(identifiersMap).toEqual([]);

            const lastNodeIndex = await global.get(LAST_NODE_INDEX_KEY);
            expect(lastNodeIndex).toBe(0);

            expect(db.getFingerprint()).toBe(fingerprint);
        } finally {
            cleanup(tmpDir);
        }
    });

    test('fresh database has valid last_node_index of 0', async () => {
        const { capabilities, tmpDir } = getTestCapabilities();
        try {
            db = await getRootDatabase(capabilities);
            const global = db.getSchemaStorage().global;
            const lastNodeIndex = await global.get(LAST_NODE_INDEX_KEY);
            expect(lastNodeIndex).toBe(0);
            expect(Number.isInteger(lastNodeIndex)).toBe(true);
        } finally {
            cleanup(tmpDir);
        }
    });

    test.each([
        ['missing', undefined],
        ['non-string', 123],
        ['too short', 'abcdefgh'],
        ['digits', 'abc123def'],
        ['uppercase', 'ABCdefghi'],
        ['punctuation', 'abcdefghi-'],
    ])('opening a versioned active replica fails for %s fingerprint', async (_description, fingerprint) => {
        const { capabilities, tmpDir } = getTestCapabilities();
        try {
            db = await getRootDatabase(capabilities);
            await db.setGlobalVersion(db.getVersion());
            const global = db.getSchemaStorage().global;
            if (fingerprint === undefined) {
                await global.del('fingerprint');
            } else {
                await global.put('fingerprint', fingerprint);
            }
            await db.close();
            db = undefined;

            await expect(getRootDatabase(capabilities)).rejects.toThrow(
                /Invalid fingerprint in active replica 'x' global metadata/
            );
        } finally {
            cleanup(tmpDir);
        }
    });

    test('replica switch rejects a malformed target fingerprint before pointer update', async () => {
        const { capabilities, tmpDir } = getTestCapabilities();
        try {
            db = await getRootDatabase(capabilities);
            const target = db.schemaStorageForReplica('y');
            await target.global.put('version', db.getVersion());
            await target.global.put(IDENTIFIERS_KEY, []);
            await target.global.put(LAST_NODE_INDEX_KEY, 0);
            await target.global.put('fingerprint', 'ABCdefghi');

            await expect(db.setCurrentReplicaPointer('y')).rejects.toThrow(
                /Invalid fingerprint in replica 'y' global metadata/
            );
            expect(db.currentReplicaName()).toBe('x');
        } finally {
            cleanup(tmpDir);
        }
    });

    test('nodeIdentifierFromString remains a nominal conversion without runtime validation', () => {
        expect(String(nodeIdentifierFromString('not a current-format identifier'))).toBe(
            'not a current-format identifier'
        );
    });

    // ── 2. Checkpoint / rendered snapshot ─────────────────────────────────

    test('rendered snapshot contains r/global/fingerprint, not _meta/fingerprint', async () => {
        const { capabilities, tmpDir } = getTestCapabilities();
        try {
            db = await getRootDatabase(capabilities);
            const fingerprint = db.getFingerprint();

            // Render the 'x' replica into a directory named 'r' (the standard
            // snapshot layout: rendered/r/ contains the active replica data).
            const renderDir = tmpDir;
            const rDir = path.join(renderDir, 'rendered', 'r');
            await renderSublevelToSnapshot(capabilities, db, { snapshotRoot: renderDir, sourceSublevel: 'x', snapshotSublevel: 'r' });

            // Render the _meta sublevel separately.
            const metaDir = path.join(renderDir, 'rendered', '_meta');
            await renderSublevelToSnapshot(capabilities, db, { snapshotRoot: renderDir, sourceSublevel: '_meta', snapshotSublevel: '_meta' });

            // Build a set of paths relative to the rendered root.
            const allFiles = [
                ...collectFiles(rDir).map(f => ({ ...f, relPath: `r/${f.relPath}` })),
                ...collectFiles(metaDir).map(f => ({ ...f, relPath: `_meta/${f.relPath}` })),
            ];
            const filePaths = new Set(allFiles.map(f => f.relPath));

            // Fingerprint must exist at r/global/fingerprint.
            expect(filePaths.has('r/global/fingerprint')).toBe(true);

            // Must NOT exist at _meta/fingerprint.
            expect(filePaths.has('_meta/fingerprint')).toBe(false);

            // Verify the rendered fingerprint value matches the live database.
            const fingerprintFile = allFiles.find(f => f.relPath === 'r/global/fingerprint');
            expect(fingerprintFile).toBeDefined();
            expect(fingerprintFile.content).toBe(fingerprint);

            // Other global metadata should be present.
            expect(fs.existsSync(path.join(renderDir, 'kindtree/r/global/identifiers_keys_map'))).toBe(true);
            expect(filePaths.has('r/global/last_node_index')).toBe(true);

            // Only _meta/current_replica should exist under _meta.
            expect(filePaths.has('_meta/current_replica')).toBe(true);
        } finally {
            cleanup(tmpDir);
        }
    });

    test('render includes all three global metadata keys alongside other data', async () => {
        const { capabilities, tmpDir } = getTestCapabilities();
        try {
            db = await getRootDatabase(capabilities);
            const fingerprint = db.getFingerprint();

            const renderDir = tmpDir;
            const rDir = path.join(renderDir, 'rendered', 'r');
            await renderSublevelToSnapshot(capabilities, db, { snapshotRoot: renderDir, sourceSublevel: 'x', snapshotSublevel: 'r' });

            // Files are relative to rDir; prepend 'r/' for snapshot layout.
            const files = collectFiles(rDir).map(f => ({ ...f, relPath: `r/${f.relPath}` }));
            const filePaths = new Set(files.map(f => f.relPath));

            expect(filePaths.has('r/global/fingerprint')).toBe(true);
            expect(fs.existsSync(path.join(renderDir, 'kindtree/r/global/identifiers_keys_map'))).toBe(true);
            expect(filePaths.has('r/global/last_node_index')).toBe(true);


            const fprintFile = files.find(f => f.relPath === 'r/global/fingerprint');
            expect(fprintFile.content).toBe(fingerprint);
        } finally {
            cleanup(tmpDir);
        }
    });

    // ── 3. First-boot restore / import ────────────────────────────────────

    test('first-boot restore: scan imports snapshot fingerprint into fresh replica', async () => {
        const { capabilities: capA, tmpDir: tmpA } = getTestCapabilities();
        try {
            // Create DB A with a known fingerprint and versioned metadata so
            // the render includes a version key. Without a version, the target
            // replica is treated as unversioned and carries forward the in-memory
            // fingerprint (from the fresh db's random seed) instead of loading
            // from disk.
            db = await getRootDatabase(capA);
            const originalFingerprint = db.getFingerprint();
            await db.setGlobalVersion(db.getVersion());

            // Render the active replica to a simulated snapshot directory.
            const snapshotDir = path.join(tmpA, 'snapshot');
            await renderSublevelToSnapshot(capA, db, { snapshotRoot: snapshotDir, sourceSublevel: 'x', snapshotSublevel: 'r' });
            await db.close();
            db = undefined;

            // Simulate first-boot: scan the snapshot into a fresh database's
            // inactive replica. Since we are simulating a first boot, there is
            // no existing database — we use a fresh one.
            const { capabilities: capB, tmpDir: tmpB } = getTestCapabilities();
            try {
                const freshDb = await getRootDatabase(capB);
                const targetReplica = freshDb.otherReplicaName();
                await scanSublevelFromSnapshot(capB, freshDb, { snapshotRoot: snapshotDir, targetSublevel: targetReplica, snapshotSublevel: 'r' });
                await freshDb.setCurrentReplicaPointer(targetReplica);
                await freshDb.close();

                // Reopen — the active replica now has the scanned fingerprint.
                const reopened = await getRootDatabase(capB);
                expect(reopened.getFingerprint()).toBe(originalFingerprint);
                await reopened.close();
            } finally {
                cleanup(tmpB);
            }
        } finally {
            cleanup(tmpA);
        }
    });

    test('first-boot rendered snapshot import rejects a malformed fingerprint', async () => {
        const { capabilities, tmpDir } = getTestCapabilities();
        try {
            db = await getRootDatabase(capabilities);
            const snapshotDir = path.join(tmpDir, 'snapshot');
            await db.getSchemaStorage().global.put('fingerprint', 'abc123def');
            await db.setGlobalVersion(db.getVersion());
            await renderSublevelToSnapshot(capabilities, db, { snapshotRoot: snapshotDir, sourceSublevel: 'x', snapshotSublevel: 'r' });

            const targetReplica = db.otherReplicaName();
            await scanSublevelFromSnapshot(capabilities, db, { snapshotRoot: snapshotDir, targetSublevel: targetReplica, snapshotSublevel: 'r' });
            await expect(db.setCurrentReplicaPointer(targetReplica)).rejects.toThrow(
                /Invalid fingerprint in replica 'y' global metadata/
            );
            expect(db.currentReplicaName()).toBe('x');
        } finally {
            cleanup(tmpDir);
        }
    });

    // ── 4. Reset / import into existing live DB ───────────────────────────

    test('reset into existing DB preserves pre-import local fingerprint', async () => {
        const { capabilities: capA, tmpDir: tmpA } = getTestCapabilities();
        try {
            db = await getRootDatabase(capA);
            const localFingerprint = db.getFingerprint();

            // Write a node to make the DB "existing" rather than empty.
            const xStorage = db.schemaStorageForReplica('x');
            await xStorage.values.put(NODE_A, { result: 'local-data' });
            await db.close();
            db = undefined;

            // Reopen to get the stable fingerprint.
            db = await getRootDatabase(capA);
            expect(db.getFingerprint()).toBe(localFingerprint);

            // Now create a "remote snapshot" with different content and
            // a potentially different fingerprint. We simulate this by
            // rendering what we have, then scanning into y, then writing
            // back the local fingerprint (as the reset path does), then
            // switching the replica pointer.
            const snapshotDir = path.join(tmpA, 'snapshot');
            await renderSublevelToSnapshot(capA, db, { snapshotRoot: snapshotDir, sourceSublevel: 'x', snapshotSublevel: 'r' });
            await db.close();
            db = undefined;

            // Reopen fresh and import the snapshot into the inactive replica,
            // preserving the local fingerprint explicitly.
            db = await getRootDatabase(capA);
            expect(db.getFingerprint()).toBe(localFingerprint);

            const targetReplica = db.otherReplicaName();
            await scanSublevelFromSnapshot(capA, db, { snapshotRoot: snapshotDir, targetSublevel: targetReplica, snapshotSublevel: 'r' });

            // Explicitly write the local fingerprint back (as reset import does).
            const targetGlobal = db.replicaGlobalSublevel(targetReplica);
            await targetGlobal.put('fingerprint', localFingerprint);

            await db.setCurrentReplicaPointer(targetReplica);
            await db.close();
            db = undefined;

            // Reopen — fingerprint must still be the local one.
            db = await getRootDatabase(capA);
            expect(db.getFingerprint()).toBe(localFingerprint);
        } finally {
            cleanup(tmpA);
        }
    });

    // ── 5. Normal sync merge preserves local fingerprint ──────────────────

    test('merge preserves local fingerprint when host has a different one', async () => {
        const { capabilities, tmpDir } = getTestCapabilities();
        try {
            db = await getRootDatabase(capabilities);
            const localFingerprint = db.getFingerprint();

            const hostname = 'remote-host';
            const appVersionStr = db.getVersion();
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            // Put a different fingerprint in the host's global sublevel.
            const hostGlobal = db.hostnameSchemaStorage(hostname).global;
            await hostGlobal.put('fingerprint', 'remotehostfingerprint');
            await hostGlobal.put(IDENTIFIERS_KEY, []);
            await hostGlobal.put(LAST_NODE_INDEX_KEY, 0);

            const logger = makeLogger();

            // Merge: host has no nodes, so this is a no-op from a graph
            // perspective. But fingerprint should stay local.
            const switched = await mergeHostIntoReplica(logger, db, hostname);
            expect(switched).toBe(false);
            expect(db.currentReplicaName()).toBe('x');
            expect(db.getFingerprint()).toBe(localFingerprint);

            // Also verify via the in-memory computed state.
            const activeGlobal = db.getSchemaStorage().global;
            const persistedFingerprint = await activeGlobal.get('fingerprint');
            expect(persistedFingerprint).toBe(localFingerprint);
        } finally {
            cleanup(tmpDir);
        }
    });

    test('merge with host that has nodes preserves local fingerprint', async () => {
        const { capabilities, tmpDir } = getTestCapabilities();
        try {
            db = await getRootDatabase(capabilities);
            const localFingerprint = db.getFingerprint();

            const hostname = 'remote-host';
            const appVersionStr = db.getVersion();
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const H = db.hostnameSchemaStorage(hostname);
            await H.inputs.put(HOST_NODE_A, { inputs: [], inputCounters: [] });
            await H.timestamps.put(HOST_NODE_A, { createdAt: TS1, modifiedAt: TS1 });
            await H.freshness.put(HOST_NODE_A, 'up-to-date');
            await H.values.put(HOST_NODE_A, { value: { id: 'a', type: 'test', description: 'a' }, isDirty: false });
            await H.global.put(IDENTIFIERS_KEY, serializeIdentifierLookup(makeIdentifierLookup([
                [HOST_NODE_A, 'node-a'],
            ])));
            await H.global.put(LAST_NODE_INDEX_KEY, 1);
            // Host has a different fingerprint.
            await H.global.put('fingerprint', 'remotehostfingerprint');

            const logger = makeLogger();
            const switched = await mergeHostIntoReplica(logger, db, hostname);
            expect(switched).toBe(true);

            // The host allocation watermark belongs to its fingerprint namespace.
            expect(db.getLastNodeIndex()).toBe(0);
            expect(await db.getSchemaStorage().global.get(LAST_NODE_INDEX_KEY)).toBe(0);

            // Local fingerprint must be preserved.
            expect(db.getFingerprint()).toBe(localFingerprint);

            // Active replica's persisted fingerprint matches local.
            const activeGlobal = db.getSchemaStorage().global;
            const persistedFingerprint = await activeGlobal.get('fingerprint');
            expect(persistedFingerprint).toBe(localFingerprint);

            // Host's fingerprint should NOT have been adopted.
            expect(persistedFingerprint).not.toBe('remotehostfingerprint');
        } finally {
            cleanup(tmpDir);
        }
    });

    // ── 6. Metadata-only host allocation metadata is ignored ─────────────

    test('metadata-only host fingerprint and last_node_index differences are a no-op', async () => {
        const { capabilities, tmpDir } = getTestCapabilities();
        try {
            db = await getRootDatabase(capabilities);
            const localFingerprint = db.getFingerprint();

            const hostname = 'remote-host';
            const appVersionStr = db.getVersion();
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const L = db.schemaStorageForReplica('x');
            const H = db.hostnameSchemaStorage(hostname);

            // Both sides have identical graph state (both empty).
            await L.global.put(IDENTIFIERS_KEY, []);
            await H.global.put(IDENTIFIERS_KEY, []);
            await L.global.put(LAST_NODE_INDEX_KEY, 0);
            await H.global.put(LAST_NODE_INDEX_KEY, 5);

            // Local fingerprint.
            await L.global.put('fingerprint', localFingerprint);
            // Host has a different fingerprint.
            await H.global.put('fingerprint', 'remotehostfingerprint');

            const logger = makeLogger();
            const switched = await mergeHostIntoReplica(logger, db, hostname);
            expect(switched).toBe(false);
            expect(db.currentReplicaName()).toBe('x');
            expect(db.getFingerprint()).toBe(localFingerprint);

            const activeGlobal = db.getSchemaStorage().global;
            expect(await activeGlobal.get('fingerprint')).toBe(localFingerprint);
            expect(await activeGlobal.get(LAST_NODE_INDEX_KEY)).toBe(0);
        } finally {
            cleanup(tmpDir);
        }
    });

    // ── 7. Restart stability ──────────────────────────────────────────────

    test('fingerprint and last_node_index survive close and reopen', async () => {
        const { capabilities, tmpDir } = getTestCapabilities();
        try {
            db = await getRootDatabase(capabilities);
            const originalFingerprint = db.getFingerprint();

            const activeGlobal = db.getSchemaStorage().global;
            const originalLastNodeIndex = await activeGlobal.get(LAST_NODE_INDEX_KEY);
            expect(originalLastNodeIndex).toBe(0);

            await db.close();
            db = undefined;

            // Reopen exactly the same database.
            db = await getRootDatabase(capabilities);

            expect(db.getFingerprint()).toBe(originalFingerprint);

            const reopenedLastNodeIndex = await db.getSchemaStorage().global.get(LAST_NODE_INDEX_KEY);
            expect(reopenedLastNodeIndex).toBe(originalLastNodeIndex);
        } finally {
            cleanup(tmpDir);
        }
    });

    test('after close/reopen, _computed fields are correctly loaded', async () => {
        const { capabilities, tmpDir } = getTestCapabilities();
        try {
            db = await getRootDatabase(capabilities);

            // Set up some state beyond the empty defaults.
            const versionStr = db.getVersion();
            await db.setGlobalVersion(versionStr);

            const fingerprint = db.getFingerprint();
            const activeGlobal = db.getSchemaStorage().global;
            await activeGlobal.put(LAST_NODE_INDEX_KEY, 3);

            await db.close();
            db = undefined;

            // Reopen.
            db = await getRootDatabase(capabilities);

            // All three must be reloaded from the persisted records.
            expect(db.getFingerprint()).toBe(fingerprint);
            const reloadedLastNodeIndex = await db.getSchemaStorage().global.get(LAST_NODE_INDEX_KEY);
            expect(reloadedLastNodeIndex).toBe(3);
        } finally {
            cleanup(tmpDir);
        }
    });
});
