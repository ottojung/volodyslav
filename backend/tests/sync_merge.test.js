/**
 * Unit tests for the per-host graph merge algorithm (sync_merge.js).
 *
 * Tests cover:
 *   - keep decision: equal timestamps keep local node
 *   - take decision: remote newer → H data copied to T
 *   - H-only additions: nodes present only in H are taken
 *   - H-only taint propagation: H-only node whose ancestor was force-kept is
 *     taken but freshness overridden to 'potentially-outdated'
 *   - missing timestamps in H: take emits del ops (no stale T timestamps survive)
 *   - version mismatch: HostVersionMismatchError thrown
 *   - replica pointer switches on success
 *   - invalidate: mixed-ancestry conflict marks freshness potentially-outdated
 */

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

/**
 * Build test capabilities backed by the temp directories created by
 * `stubEnvironment`.  No additional temp directory is needed.
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
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
    await storage.inputs.put(nodeKey, { inputs: inputKeys, inputCounters: [] });
    await storage.timestamps.put(nodeKey, { createdAt: modifiedAt, modifiedAt });
    await storage.freshness.put(nodeKey, 'up-to-date');
    if (valuePayload !== undefined) {
        await storage.values.put(nodeKey, valuePayload);
    }
}

describe('mergeHostIntoReplica', () => {
    test('throws HostVersionMismatchError when remote version differs from local', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            await db.setMetaVersion(db.version);
            // Set remote version to something incompatible.
            await db.setHostnameMeta('remote-host', 'version', 'incompatible-version');

            await expect(
                mergeHostIntoReplica(logger, db, 'remote-host')
            ).rejects.toBeInstanceOf(HostVersionMismatchError);
        } finally {
            if (db) await db.close();
        }
    });

    test('isHostVersionMismatchError identifies the error', () => {
        const err = new HostVersionMismatchError('host', 'v1', 'v2');
        expect(isHostVersionMismatchError(err)).toBe(true);
        expect(isHostVersionMismatchError(new Error('other'))).toBe(false);
    });

    test('keeps local node when timestamps are equal', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
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
            if (db) await db.close();
        }
    });

    test('takes remote node when remote timestamp is newer', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
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
            if (db) await db.close();
        }
    });

    test('H-only node (not in L) is taken and added to merged replica', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
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
            if (db) await db.close();
        }
    });

    test('H-only node dependent on force-kept T ancestor is taken but marked potentially-outdated', async () => {
        // Graph in H:  P → C  (C depends on P)
        // T has P, force-kept (T-newer); H introduces C (H-only) that depends on P.
        // C was computed on the remote using H's older P, but T's P is newer.
        // Expected: C is taken (structural data copied) but freshness = 'potentially-outdated'.
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setMetaVersion(appVersionStr);
            await db.setHostnameMeta(hostname, 'version', appVersionStr);

            const nodeP = nk('p');  // shared node; T is newer (force-keep)
            const nodeC = nk('c');  // H-only node that depends on P

            const localPValue = { value: { id: 'p-local', type: 'test', description: 'newer local P' }, isDirty: false };
            const remoteCValue = { value: { id: 'c-remote', type: 'test', description: 'stale remote C' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            // P: T has a strictly newer timestamp → force-keep
            await writeNode(L, nodeP, TS3, [], localPValue);

            const H = db.hostnameSchemaStorage(hostname);
            // P in H is older
            await writeNode(H, nodeP, TS1, [], undefined);
            // C is only in H; it depends on P (computed from H's stale P)
            await writeNode(H, nodeC, TS2, [nodeP], remoteCValue);

            await mergeHostIntoReplica(logger, db, hostname);

            const newActive = db.currentReplicaName();
            const T = db.schemaStorageForReplica(newActive);

            // C must exist (data taken from H) but freshness must be potentially-outdated
            // because it was computed on the remote with an older version of P.
            const cValue = await T.values.get(nodeC);
            expect(cValue).toEqual(remoteCValue);
            const cFreshness = await T.freshness.get(nodeC);
            expect(cFreshness).toBe('potentially-outdated');
        } finally {
            if (db) await db.close();
        }
    });

    test('missing timestamps in H do not leave stale T timestamps after take', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setMetaVersion(appVersionStr);
            await db.setHostnameMeta(hostname, 'version', appVersionStr);

            // Write an H-only node without a timestamps record.
            const hOnlyNode = nk('h-only-no-ts');
            const H = db.hostnameSchemaStorage(hostname);
            await H.inputs.put(hOnlyNode, { inputs: [], inputCounters: [] });
            await H.freshness.put(hOnlyNode, 'up-to-date');

            await mergeHostIntoReplica(logger, db, hostname);

            const newActive = db.currentReplicaName();
            const T = db.schemaStorageForReplica(newActive);

            // The H-only node was taken; buildTakeOps emits delOp for missing timestamps.
            const takenTs = await T.timestamps.get(hOnlyNode);
            expect(takenTs).toBeUndefined();
        } finally {
            if (db) await db.close();
        }
    });

    test('replica pointer switches after successful merge', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
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
            if (db) await db.close();
        }
    });

    test('invalidates taken node when H.inputs rewires it to a force-kept ancestor', async () => {
        // Scenario: in T, B has no dependency on A.
        //           in H, B depends on A (edge added remotely).
        // A is force-kept (T-newer); B is force-taken (H-newer).
        // With T-only taint propagation B would just be 'take'.
        // With the merged-graph: B's merged inputs include A, so B gets
        // both keepTainted (via A) and takeTainted (B itself) → 'invalidate'.
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setMetaVersion(appVersionStr);
            await db.setHostnameMeta(hostname, 'version', appVersionStr);

            const nodeA = nk('a');
            const nodeB = nk('b');
            const localValueB = { value: { id: 'b-local', type: 'test', description: 'local B' }, isDirty: false };
            const remoteValueB = { value: { id: 'b-remote', type: 'test', description: 'remote B' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            // In T: A is force-kept (T-newer); B has no deps (independent of A).
            await writeNode(L, nodeA, TS3, [], undefined);
            await writeNode(L, nodeB, TS1, [], localValueB);

            const H = db.hostnameSchemaStorage(hostname);
            // In H: A is older; B is newer AND now depends on A.
            await writeNode(H, nodeA, TS1, [], undefined);
            await writeNode(H, nodeB, TS2, [nodeA], remoteValueB);

            await mergeHostIntoReplica(logger, db, hostname);

            const newActive = db.currentReplicaName();
            const T = db.schemaStorageForReplica(newActive);

            // B should be 'invalidate' because its merged inputs include the
            // force-kept A, making it keepTainted AND takeTainted.
            const bFreshness = await T.freshness.get(nodeB);
            expect(bFreshness).toBe('potentially-outdated');
        } finally {
            if (db) await db.close();
        }
    });

    test('preserves replica version when source replica is empty', async () => {
        // When the local replica has no data (ops is empty),
        // dst.batch([]) performs no writes. Without the explicit
        // setMetaVersionForReplica call, the switched-to replica would
        // have no version and the next host merge would fail with
        // HostVersionMismatchError(local=(none), remote=<version>).
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();

            // First host: set version on local replica but add no nodes.
            const hostname1 = 'peer1';
            const appVersionStr = db.version;
            await db.setMetaVersion(appVersionStr);
            await db.setHostnameMeta(hostname1, 'version', appVersionStr);

            // Merge first host (empty local replica → ops is empty).
            await mergeHostIntoReplica(logger, db, hostname1);
            // Replica pointer now points to 'y'.
            expect(db.currentReplicaName()).toBe('y');

            // Second host: same version, with one node.
            const hostname2 = 'peer2';
            await db.setHostnameMeta(hostname2, 'version', appVersionStr);
            const nodeA = nk('a');
            const remoteValue = { value: { id: 'a', type: 'test', description: 'a' }, isDirty: false };
            const H2 = db.hostnameSchemaStorage(hostname2);
            await writeNode(H2, nodeA, TS1, [], remoteValue);

            // Should NOT throw HostVersionMismatchError even though the first
            // merge left an empty 'y' replica with no version before this fix.
            await expect(
                mergeHostIntoReplica(logger, db, hostname2)
            ).resolves.toBeUndefined();
        } finally {
            if (db) await db.close();
        }
    });
});
