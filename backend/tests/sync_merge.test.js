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
 *   - invalidate: mixed-ancestry conflict (one ancestor force-keep, another force-take)
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const {
    getRootDatabase,
    versionToString,
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

function ts(offsetMs) {
    return new Date(offsetMs).toISOString();
}

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
                const appVersion = versionToString(db.version);
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
                const appVersion = versionToString(db.version);
                await db.setMetaVersion(db.version);
                // Align staging meta version with app version.
                await db.setHostnameMeta(hostname, 'version', appVersion);

                const nodeA = nk('a');
                const timestamp = ts(1000);
                const localValue = { value: { id: 'local', type: 'test', description: 'local value' }, isDirty: false };
                const remoteValue = { value: { id: 'remote', type: 'test', description: 'remote value' }, isDirty: false };

                const L = db.schemaStorageForReplica('x');
                await writeNode(L, nodeA, timestamp, [], localValue);

                const H = db.hostnameSchemaStorage(hostname);
                await writeNode(H, nodeA, timestamp, [], remoteValue);

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
                const appVersion = versionToString(db.version);
                await db.setMetaVersion(db.version);
                await db.setHostnameMeta(hostname, 'version', appVersion);

                const nodeA = nk('a');
                const olderTs = ts(1000);
                const newerTs = ts(5000);
                const localValue = { value: { id: 'local', type: 'test', description: 'local value' }, isDirty: false };
                const remoteValue = { value: { id: 'remote', type: 'test', description: 'remote value' }, isDirty: false };

                const L = db.schemaStorageForReplica('x');
                await writeNode(L, nodeA, olderTs, [], localValue);

                const H = db.hostnameSchemaStorage(hostname);
                await writeNode(H, nodeA, newerTs, [], remoteValue);

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
                const appVersion = versionToString(db.version);
                await db.setMetaVersion(db.version);
                await db.setHostnameMeta(hostname, 'version', appVersion);

                const nodeA = nk('a-only-in-h');
                const remoteValue = { value: { id: 'h-only', type: 'test', description: 'h only' }, isDirty: false };

                const H = db.hostnameSchemaStorage(hostname);
                await writeNode(H, nodeA, ts(1000), [], remoteValue);

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
                const appVersion = versionToString(db.version);
                await db.setMetaVersion(db.version);
                await db.setHostnameMeta(hostname, 'version', appVersion);

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
                const appVersion = versionToString(db.version);
                await db.setMetaVersion(db.version);
                await db.setHostnameMeta(hostname, 'version', appVersion);

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
                const appVersion = versionToString(db.version);
                await db.setMetaVersion(db.version);
                await db.setHostnameMeta(hostname, 'version', appVersion);

                // Graph:  A → C, B → C  (C depends on both A and B)
                // A is locally newer (force-keep root),
                // B is remotely newer (force-take root).
                // C should be invalidated.
                const nodeA = nk('a');
                const nodeB = nk('b');
                const nodeC = nk('c');
                const olderTs = ts(1000);
                const newerLocalTs = ts(9000);
                const newerRemoteTs = ts(8000);
                const localValueC = { value: { id: 'c-local', type: 'test', description: 'c local' }, isDirty: false };

                const L = db.schemaStorageForReplica('x');
                await writeNode(L, nodeA, newerLocalTs, [], undefined);
                await writeNode(L, nodeB, olderTs, [], undefined);
                await writeNode(L, nodeC, olderTs, [nodeA, nodeB], localValueC);

                const H = db.hostnameSchemaStorage(hostname);
                await writeNode(H, nodeA, olderTs, [], undefined);
                await writeNode(H, nodeB, newerRemoteTs, [], undefined);
                await writeNode(H, nodeC, olderTs, [nodeA, nodeB], undefined);

                await mergeHostIntoReplica(logger, db, hostname);

                const newActive = db.currentReplicaName();
                const T = db.schemaStorageForReplica(newActive);

                // C is invalidated → freshness = 'potentially-outdated', no value.
                const cFreshness = await T.freshness.get(nodeC);
                expect(cFreshness).toBe('potentially-outdated');
                const cValue = await T.values.get(nodeC);
                expect(cValue).toBeUndefined();
            } finally {
                await db.close();
            }
        } finally {
            fs.rmSync(capabilities._tmpDir, { recursive: true, force: true });
        }
    });
});
