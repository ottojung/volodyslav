/**
 * Unit tests for the per-host graph merge algorithm (sync_merge.js).
 *
 * Tests cover:
 *   - keep decision: equal timestamps keep local node
 *   - take decision: remote newer → H data copied to T
 *   - H-only additions: nodes present only in H are taken
 *   - missing timestamps in H: take emits del ops (no stale T timestamps survive)
 *   - version mismatch: HostVersionMismatchError thrown
 *   - replica pointer switches on success
 *   - invalidate: mixed-ancestry conflict marks freshness potentially-outdated
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const {
    getRootDatabase,
} = require('../src/generators/incremental_graph/database');
const {
    mergeHostIntoReplica,
    HostVersionMismatchError,
    isHostVersionMismatchError,
} = require('../src/generators/incremental_graph/database/sync_merge');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');

jest.setTimeout(20000);

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-merge-test-'));
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    capabilities._tmpDir = tmpDir;
    return capabilities;
}

function makeLogger() {
    return {
        logInfo: jest.fn(),
        logDebug: jest.fn(),
        logWarning: jest.fn(),
        logError: jest.fn(),
    };
}

function nk(name) {
    return `{"head":"${name}","args":[]}`;
}

// Hardcoded ISO 8601 UTC timestamps for test reproducibility.
// Values are chosen to be clearly ordered: TS1 < TS2 < TS3.
const TS1 = '2024-01-01T00:00:01.000Z';
const TS2 = '2024-01-01T00:00:05.000Z';
const TS3 = '2024-01-01T00:00:09.000Z';

/**
 * Write a node into storage with a modifiedAt timestamp.
 */
async function writeNode(storage, nodeKey, modifiedAt, inputKeys, valuePayload) {
    await storage.inputs.put(nodeKey, { inputs: inputKeys });
    await storage.timestamps.put(nodeKey, { createdAt: modifiedAt, modifiedAt });
    await storage.freshness.put(nodeKey, 'up-to-date');
    if (valuePayload !== undefined) {
        await storage.values.put(nodeKey, valuePayload);
    }
}

describe('mergeHostIntoReplica', () => {
    test('throws HostVersionMismatchError when remote version differs from local', async () => {
        const capabilities = getTestCapabilities();
        try {
            const db = await getRootDatabase(capabilities);
            try {
                const logger = makeLogger();
                await db.setMetaVersion(db.version);
                // Set remote version to something incompatible.
                await db.setHostnameMeta('remote-host', 'version', 'incompatible-version');

                await expect(
                    mergeHostIntoReplica(logger, db, 'remote-host')
                ).rejects.toBeInstanceOf(HostVersionMismatchError);
            } finally {
                await db.close();
            }
        } finally {
            fs.rmSync(capabilities._tmpDir, { recursive: true, force: true });
        }
    });

    test('isHostVersionMismatchError identifies the error', () => {
        const err = new HostVersionMismatchError('host', 'v1', 'v2');
        expect(isHostVersionMismatchError(err)).toBe(true);
        expect(isHostVersionMismatchError(new Error('other'))).toBe(false);
    });

    test('keeps local node when timestamps are equal', async () => {
        const capabilities = getTestCapabilities();
        try {
            const db = await getRootDatabase(capabilities);
            try {
                const logger = makeLogger();
                const hostname = 'peer';
                const appVersionStr = db.version;
                await db.setMetaVersion(appVersionStr);
                await db.setHostnameMeta(hostname, 'version', appVersionStr);

                const nodeA = nk('a');
                const localValue = { value: { id: 'local', type: 'test', description: 'local value' }, isDirty: false };
                const remoteValue = { value: { id: 'remote', type: 'test', description: 'remote value' }, isDirty: false };

                const L = db.schemaStorageForReplica('x');
                await writeNode(L, nodeA, TS1, [], localValue);

                const H = db.hostnameSchemaStorage(hostname);
                await writeNode(H, nodeA, TS1, [], remoteValue);

                await mergeHostIntoReplica(logger, db, hostname);

                const newActive = db.currentReplicaName();
                expect(newActive).toBe('y');

                const T = db.schemaStorageForReplica(newActive);
                const merged = await T.values.get(nodeA);
                expect(merged).toEqual(localValue);
            } finally {
                await db.close();
            }
        } finally {
            fs.rmSync(capabilities._tmpDir, { recursive: true, force: true });
        }
    });

    test('takes remote node when remote timestamp is newer', async () => {
        const capabilities = getTestCapabilities();
        try {
            const db = await getRootDatabase(capabilities);
            try {
                const logger = makeLogger();
                const hostname = 'peer';
                const appVersionStr = db.version;
                await db.setMetaVersion(appVersionStr);
                await db.setHostnameMeta(hostname, 'version', appVersionStr);

                const nodeA = nk('a');
                const localValue = { value: { id: 'local', type: 'test', description: 'local value' }, isDirty: false };
                const remoteValue = { value: { id: 'remote', type: 'test', description: 'remote value' }, isDirty: false };

                const L = db.schemaStorageForReplica('x');
                await writeNode(L, nodeA, TS1, [], localValue);

                const H = db.hostnameSchemaStorage(hostname);
                await writeNode(H, nodeA, TS2, [], remoteValue);

                await mergeHostIntoReplica(logger, db, hostname);

                const newActive = db.currentReplicaName();
                expect(newActive).toBe('y');

                const T = db.schemaStorageForReplica(newActive);
                const merged = await T.values.get(nodeA);
                expect(merged).toEqual(remoteValue);
            } finally {
                await db.close();
            }
        } finally {
            fs.rmSync(capabilities._tmpDir, { recursive: true, force: true });
        }
    });

    test('H-only node (not in L) is taken and added to merged replica', async () => {
        const capabilities = getTestCapabilities();
        try {
            const db = await getRootDatabase(capabilities);
            try {
                const logger = makeLogger();
                const hostname = 'peer';
                const appVersionStr = db.version;
                await db.setMetaVersion(appVersionStr);
                await db.setHostnameMeta(hostname, 'version', appVersionStr);

                const nodeA = nk('a-only-in-h');
                const remoteValue = { value: { id: 'h-only', type: 'test', description: 'h only' }, isDirty: false };

                const H = db.hostnameSchemaStorage(hostname);
                await writeNode(H, nodeA, TS1, [], remoteValue);

                await mergeHostIntoReplica(logger, db, hostname);

                const newActive = db.currentReplicaName();
                expect(newActive).toBe('y');

                const T = db.schemaStorageForReplica(newActive);
                const merged = await T.values.get(nodeA);
                expect(merged).toEqual(remoteValue);
            } finally {
                await db.close();
            }
        } finally {
            fs.rmSync(capabilities._tmpDir, { recursive: true, force: true });
        }
    });

    test('missing timestamps in H do not leave stale T timestamps after take', async () => {
        const capabilities = getTestCapabilities();
        try {
            const db = await getRootDatabase(capabilities);
            try {
                const logger = makeLogger();
                const hostname = 'peer';
                const appVersionStr = db.version;
                await db.setMetaVersion(appVersionStr);
                await db.setHostnameMeta(hostname, 'version', appVersionStr);

                // Write an H-only node without a timestamps record.
                const hOnlyNode = nk('h-only-no-ts');
                const H = db.hostnameSchemaStorage(hostname);
                await H.inputs.put(hOnlyNode, { inputs: [] });
                await H.freshness.put(hOnlyNode, 'up-to-date');

                await mergeHostIntoReplica(logger, db, hostname);

                const newActive = db.currentReplicaName();
                const T = db.schemaStorageForReplica(newActive);

                // The H-only node was taken; buildTakeOps emits delOp for missing timestamps.
                const takenTs = await T.timestamps.get(hOnlyNode);
                expect(takenTs).toBeUndefined();
            } finally {
                await db.close();
            }
        } finally {
            fs.rmSync(capabilities._tmpDir, { recursive: true, force: true });
        }
    });

    test('replica pointer switches after successful merge', async () => {
        const capabilities = getTestCapabilities();
        try {
            const db = await getRootDatabase(capabilities);
            try {
                const logger = makeLogger();
                const hostname = 'peer';
                const appVersionStr = db.version;
                await db.setMetaVersion(appVersionStr);
                await db.setHostnameMeta(hostname, 'version', appVersionStr);

                const before = db.currentReplicaName();
                expect(before).toBe('x');

                await mergeHostIntoReplica(logger, db, hostname);

                const after = db.currentReplicaName();
                expect(after).toBe('y');
            } finally {
                await db.close();
            }
        } finally {
            fs.rmSync(capabilities._tmpDir, { recursive: true, force: true });
        }
    });

    test('invalidates node whose ancestors come from both keep and take lineages', async () => {
        const capabilities = getTestCapabilities();
        try {
            const db = await getRootDatabase(capabilities);
            try {
                const logger = makeLogger();
                const hostname = 'peer';
                const appVersionStr = db.version;
                await db.setMetaVersion(appVersionStr);
                await db.setHostnameMeta(hostname, 'version', appVersionStr);

                // Graph:  A → C, B → C  (C depends on both A and B)
                // A is locally newer (force-keep root),
                // B is remotely newer (force-take root).
                // C should be invalidated (freshness = 'potentially-outdated').
                const nodeA = nk('a');
                const nodeB = nk('b');
                const nodeC = nk('c');
                const localValueC = { value: { id: 'c-local', type: 'test', description: 'c local' }, isDirty: false };

                const L = db.schemaStorageForReplica('x');
                await writeNode(L, nodeA, TS3, [], undefined);
                await writeNode(L, nodeB, TS1, [], undefined);
                await writeNode(L, nodeC, TS1, [nodeA, nodeB], localValueC);

                const H = db.hostnameSchemaStorage(hostname);
                await writeNode(H, nodeA, TS1, [], undefined);
                await writeNode(H, nodeB, TS2, [], undefined);
                await writeNode(H, nodeC, TS1, [nodeA, nodeB], undefined);

                await mergeHostIntoReplica(logger, db, hostname);

                const newActive = db.currentReplicaName();
                const T = db.schemaStorageForReplica(newActive);

                // C is invalidated → freshness = 'potentially-outdated'.
                // The old value is retained (not deleted) until the node is recomputed.
                const cFreshness = await T.freshness.get(nodeC);
                expect(cFreshness).toBe('potentially-outdated');
            } finally {
                await db.close();
            }
        } finally {
            fs.rmSync(capabilities._tmpDir, { recursive: true, force: true });
        }
    });
});
