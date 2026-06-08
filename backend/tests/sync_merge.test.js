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
 *   - replica pointer switches only when merge introduces changes
 *   - invalidate: mixed-ancestry conflict marks freshness potentially-outdated
 */

const {
    IDENTIFIERS_KEY,
    getRootDatabase,
    isMalformedIdentifierLookupError,
    isMissingIdentifierLookupError,
    makeIdentifierLookup,
    nodeIdentifierFromString,
    nodeIdentifierToString,
    nodeKeyStringToString,
    serializeIdentifierLookup,
    stringToNodeKeyString,
} = require('../src/generators/incremental_graph/database');
const {
    IdentifierLookupConflictError,
    isIdentifierLookupConflictError,
} = require('../src/generators/incremental_graph/database/replica_errors');
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

// Current-format deterministic NodeIdentifiers used as test node keys.
const NODE_A = nodeIdentifierFromString('1-abcdefghi');
const NODE_B = nodeIdentifierFromString('2-abcdefghi');
const NODE_C = nodeIdentifierFromString('3-abcdefghi');
const NODE_P = nodeIdentifierFromString('4-abcdefghi');
const NODE_H = nodeIdentifierFromString('5-abcdefghi');

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

/**
 * @param {import('../src/generators/incremental_graph/database/root_database').SchemaStorage} storage
 * @param {Array<[import('../src/generators/incremental_graph/database').NodeIdentifier, import('../src/generators/incremental_graph/database').NodeKeyString]>} entries
 * @returns {Promise<void>}
 */
async function writeIdentifierLookup(storage, entries) {
    await storage.global.put(IDENTIFIERS_KEY, serializeIdentifierLookup(makeIdentifierLookup(entries)));
}

/**
 * @param {Array<import('../src/generators/incremental_graph/database').NodeIdentifier>} nodeIdentifiers
 * @returns {Array<[import('../src/generators/incremental_graph/database').NodeIdentifier, import('../src/generators/incremental_graph/database').NodeKeyString]>}
 */
function entriesForSameStringNodeKeys(nodeIdentifiers) {
    return nodeIdentifiers.map((nodeIdentifier) => [
        nodeIdentifier,
        stringToNodeKeyString(String(nodeIdentifier)),
    ]);
}

/**
 * @param {ReturnType<typeof getTestCapabilities>} capabilities
 * @param {ReturnType<typeof makeLogger>} logger
 * @param {import('../src/generators/incremental_graph/database/root_database').RootDatabase} db
 * @param {string} hostname
 * @returns {Promise<import('../src/generators/incremental_graph/database/root_database').RootDatabase>}
 */
async function mergeAndReopenIfSwitched(capabilities, logger, db, hostname) {
    const switched = await mergeHostIntoReplica(logger, db, hostname);
    if (!switched) {
        return db;
    }
    await db.close();
    return await getRootDatabase(capabilities);
}

describe('mergeHostIntoReplica', () => {
    test('throws HostVersionMismatchError when remote version differs from local', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            await db.setGlobalVersion(db.version);
            // Set remote version to something incompatible.
            await db.setHostnameGlobal('remote-host', 'version', 'incompatible-version');

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
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeA = NODE_A;
            const localValue = { value: { id: 'local', type: 'test', description: 'local value' }, isDirty: false };
            const remoteValue = { value: { id: 'remote', type: 'test', description: 'remote value' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeA, TS1, [], localValue);
            await writeIdentifierLookup(L, entriesForSameStringNodeKeys([nodeA]));

            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, nodeA, TS1, [], remoteValue);
            await writeIdentifierLookup(H, entriesForSameStringNodeKeys([nodeA]));

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const newActive = db.currentReplicaName();
            expect(newActive).toBe('x');

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
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeA = NODE_A;
            const localValue = { value: { id: 'local', type: 'test', description: 'local value' }, isDirty: false };
            const remoteValue = { value: { id: 'remote', type: 'test', description: 'remote value' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeA, TS1, [], localValue);
            await writeIdentifierLookup(L, entriesForSameStringNodeKeys([nodeA]));

            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, nodeA, TS2, [], remoteValue);
            await writeIdentifierLookup(H, entriesForSameStringNodeKeys([nodeA]));

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const newActive = db.currentReplicaName();
            expect(newActive).toBe('y');

            const T = db.schemaStorageForReplica(newActive);
            const merged = await T.values.get(nodeA);
            expect(merged).toEqual(remoteValue);
        } finally {
            if (db) await db.close();
        }
    });

    test('reconciles different identifiers across multiple semantic nodes', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const targetParent = nodeIdentifierFromString('6-abcdefghi');
            const targetChild = nodeIdentifierFromString('7-abcdefghi');
            const hostParent = nodeIdentifierFromString('8-abcdefghi');
            const hostChild = nodeIdentifierFromString('9-abcdefghi');
            const parentKey = stringToNodeKeyString('{"head":"parent","args":[]}');
            const childKey = stringToNodeKeyString('{"head":"child","args":[]}');
            const L = db.schemaStorageForReplica('x');
            await writeNode(L, targetParent, TS1, [], undefined);
            await writeNode(L, targetChild, TS1, [targetParent], undefined);
            await writeIdentifierLookup(L, [[targetParent, parentKey], [targetChild, childKey]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, hostParent, TS1, [], undefined);
            await writeNode(H, hostChild, TS2, [hostParent], undefined);
            await writeIdentifierLookup(H, [[hostParent, parentKey], [hostChild, childKey]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);
            const T = db.getSchemaStorage();
            expect(await T.global.get(IDENTIFIERS_KEY)).toEqual([
                [targetParent, parentKey],
                [hostChild, childKey],
            ]);
            expect(await T.inputs.get(hostChild)).toEqual({ inputs: [targetParent], inputCounters: [] });
            expect(await T.inputs.get(targetChild)).toBeUndefined();
            expect(await T.inputs.get(hostParent)).toBeUndefined();
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
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeA = NODE_A;
            const remoteValue = { value: { id: 'h-only', type: 'test', description: 'h only' }, isDirty: false };

            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, nodeA, TS1, [], remoteValue);
            const L = db.schemaStorageForReplica('x');
            await writeIdentifierLookup(L, []);
            await writeIdentifierLookup(H, entriesForSameStringNodeKeys([nodeA]));

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

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
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeP = NODE_P;  // shared node; T is newer (force-keep)
            const nodeC = NODE_C;  // H-only node that depends on P

            const localPValue = { value: { id: 'p-local', type: 'test', description: 'newer local P' }, isDirty: false };
            const remoteCValue = { value: { id: 'c-remote', type: 'test', description: 'stale remote C' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            // P: T has a strictly newer timestamp → force-keep
            await writeNode(L, nodeP, TS3, [], localPValue);
            await writeIdentifierLookup(L, entriesForSameStringNodeKeys([nodeP]));

            const H = db.hostnameSchemaStorage(hostname);
            // P in H is older
            await writeNode(H, nodeP, TS1, [], undefined);
            // C is only in H; it depends on P (computed from H's stale P)
            await writeNode(H, nodeC, TS2, [nodeP], remoteCValue);
            await writeIdentifierLookup(H, entriesForSameStringNodeKeys([nodeP, nodeC]));

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

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
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            // Write an H-only node without a timestamps record.
            const hOnlyNode = NODE_H;
            const H = db.hostnameSchemaStorage(hostname);
            await H.inputs.put(hOnlyNode, { inputs: [], inputCounters: [] });
            await H.freshness.put(hOnlyNode, 'up-to-date');
            const L = db.schemaStorageForReplica('x');
            await writeIdentifierLookup(L, []);
            await writeIdentifierLookup(H, entriesForSameStringNodeKeys([hOnlyNode]));

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const newActive = db.currentReplicaName();
            const T = db.schemaStorageForReplica(newActive);

            // The H-only node was taken; copyNodeOps emits delOp for missing timestamps.
            const takenTs = await T.timestamps.get(hOnlyNode);
            expect(takenTs).toBeUndefined();
        } finally {
            if (db) await db.close();
        }
    });

    test('replica pointer does not switch after no-op merge', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const before = db.currentReplicaName();
            expect(before).toBe('x');
            const L = db.schemaStorageForReplica('x');
            const H = db.hostnameSchemaStorage(hostname);
            await writeIdentifierLookup(L, []);
            await writeIdentifierLookup(H, []);

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const after = db.currentReplicaName();
            expect(after).toBe('x');
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
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeA = NODE_A;
            const nodeB = NODE_B;
            const localValueB = { value: { id: 'b-local', type: 'test', description: 'local B' }, isDirty: false };
            const remoteValueB = { value: { id: 'b-remote', type: 'test', description: 'remote B' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            // In T: A is force-kept (T-newer); B has no deps (independent of A).
            await writeNode(L, nodeA, TS3, [], undefined);
            await writeNode(L, nodeB, TS1, [], localValueB);
            await L.counters.put(nodeB, 1);
            await writeIdentifierLookup(L, entriesForSameStringNodeKeys([nodeA, nodeB]));

            const H = db.hostnameSchemaStorage(hostname);
            // In H: A is older; B is newer AND now depends on A.
            await writeNode(H, nodeA, TS1, [], undefined);
            await writeNode(H, nodeB, TS2, [nodeA], remoteValueB);
            await H.counters.put(nodeB, 2);
            await writeIdentifierLookup(H, entriesForSameStringNodeKeys([nodeA, nodeB]));

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const newActive = db.currentReplicaName();
            const T = db.schemaStorageForReplica(newActive);

            // B should be 'invalidate' because its merged inputs include the
            // force-kept A, making it keepTainted AND takeTainted.
            const bFreshness = await T.freshness.get(nodeB);
            expect(bFreshness).toBe('potentially-outdated');

            // Because initial decision for B was 'take', invalidate must still
            // apply H's structural state so inputs/revdeps remain consistent.
            const bInputs = await T.inputs.get(nodeB);
            expect(bInputs).toEqual({
                inputs: [nodeA],
                inputCounters: [],
            });
            const bCounter = await T.counters.get(nodeB);
            expect(bCounter).toBe(2);
            const bValue = await T.values.get(nodeB);
            expect(bValue).toEqual(remoteValueB);

            // B's modifiedAt should be advanced to H's value (TS2) so that on
            // the next sync, compareIsoTimestamps(T.B, H.B) == 0 → 'keep', breaking
            // the repeated-invalidation cycle.
            const bTimestamps = await T.timestamps.get(nodeB);
            expect(bTimestamps?.modifiedAt).toBe(TS2);
            // createdAt should be preserved from T (not overwritten from H).
            expect(bTimestamps?.createdAt).toBe(TS1); // T wrote createdAt = TS1
        } finally {
            if (db) await db.close();
        }
    });

    test('invalidated node does not re-invalidate on a second sync with same H', async () => {
        // After the first merge advances T.B.modifiedAt to H.B.modifiedAt (TS2),
        // a second merge with the same H data should leave B as 'keep' (not
        // repeatedly invalidated).
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeA = NODE_A;
            const nodeB = NODE_B;
            const localValueB = { value: { id: 'b-local', type: 'test', description: 'local B' }, isDirty: false };
            const remoteValueB = { value: { id: 'b-remote', type: 'test', description: 'remote B' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeA, TS3, [], undefined);
            await writeNode(L, nodeB, TS1, [], localValueB);
            await writeIdentifierLookup(L, entriesForSameStringNodeKeys([nodeA, nodeB]));

            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, nodeA, TS1, [], undefined);
            await writeNode(H, nodeB, TS2, [nodeA], remoteValueB);
            await writeIdentifierLookup(H, entriesForSameStringNodeKeys([nodeA, nodeB]));

            // First merge: B is 'invalidate', modifiedAt advanced to TS2.
            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            // Restore the same H staging data for the second merge
            // (simulates a re-sync against the same remote snapshot).
            // Re-write H since clearHostnameStorage may have been called by caller
            // in production; in this test we write it directly.
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);
            const H2 = db.hostnameSchemaStorage(hostname);
            await writeNode(H2, nodeA, TS1, [], undefined);
            await writeNode(H2, nodeB, TS2, [nodeA], remoteValueB);
            await writeIdentifierLookup(H2, entriesForSameStringNodeKeys([nodeA, nodeB]));

            // Second merge: T.B.modifiedAt == H.B.modifiedAt == TS2 → B is 'keep'.
            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const newActive = db.currentReplicaName();
            const T = db.schemaStorageForReplica(newActive);

            // After timestamp advancement, T.B.modifiedAt == H.B.modifiedAt == TS2.
            // On the second sync, compareIsoTimestamps returns 0 so B gets merge
            // decision 'keep' (no taint); freshness is unchanged from the first merge.
            const bFreshness = await T.freshness.get(nodeB);
            expect(bFreshness).toBe('potentially-outdated');
            const bTimestamps = await T.timestamps.get(nodeB);
            // modifiedAt still equals TS2 — not re-advanced (it was already equal to H's).
            expect(bTimestamps?.modifiedAt).toBe(TS2);
        } finally {
            if (db) await db.close();
        }
    });

    test('preserves replica version when source replica is empty', async () => {
        // When the local replica has no data (ops is empty),
        // dst.batch([]) performs no writes. Without the explicit
        // copyReplicaGently now copies global/version via unifyStores. Without it, the switched-to replica would
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
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname1, 'version', appVersionStr);
            const L = db.schemaStorageForReplica('x');
            const H1 = db.hostnameSchemaStorage(hostname1);
            await writeIdentifierLookup(L, []);
            await writeIdentifierLookup(H1, []);

            // Merge first host (empty local replica → no graph changes).
            await mergeHostIntoReplica(logger, db, hostname1);
            // No-op merge keeps the current replica pointer.
            expect(db.currentReplicaName()).toBe('x');

            // Second host: same version, with one node.
            const hostname2 = 'peer2';
            await db.setHostnameGlobal(hostname2, 'version', appVersionStr);
            const nodeA = NODE_A;
            const remoteValue = { value: { id: 'a', type: 'test', description: 'a' }, isDirty: false };
            const H2 = db.hostnameSchemaStorage(hostname2);
            await writeNode(H2, nodeA, TS1, [], remoteValue);
            await writeIdentifierLookup(H2, entriesForSameStringNodeKeys([nodeA]));

            // Should NOT throw HostVersionMismatchError even though the first
            // merge left an empty 'y' replica with no version before this fix.
            await expect(
                mergeHostIntoReplica(logger, db, hostname2)
            ).resolves.toBe(true);
        } finally {
            if (db) await db.close();
        }
    });

    test('replica pointer and schema storage are immediately coherent after cutover without reopening DB', async () => {
        // Objective 2: setCurrentReplicaPointer atomically updates both the
        // persisted _meta/current_replica and this._computed in the same call.
        // This test verifies that callers never observe stale in-memory pointer
        // state after a successful merge that triggers a cutover.
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            // Write a remote node with a strictly newer timestamp so the merge
            // produces changes and triggers a replica cutover.
            const nodeA = NODE_A;
            const remoteValue = { value: { id: 'remote', type: 'test', description: 'remote value' }, isDirty: false };
            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, nodeA, TS2, [], remoteValue);
            const L = db.schemaStorageForReplica('x');
            await writeIdentifierLookup(L, entriesForSameStringNodeKeys([nodeA]));
            await writeIdentifierLookup(H, entriesForSameStringNodeKeys([nodeA]));

            // Verify precondition: active replica is 'x' before the merge.
            expect(db.currentReplicaName()).toBe('x');

            // Call mergeHostIntoReplica directly — do NOT reopen the DB.
            const switched = await mergeHostIntoReplica(logger, db, hostname);

            // The merge must have triggered a cutover.
            expect(switched).toBe(true);

            // In-memory pointer must be immediately coherent (no reopen needed).
            expect(db.currentReplicaName()).toBe('y');

            // Schema storage must also reflect the new replica immediately.
            const T = db.getSchemaStorage();
            const merged = await T.values.get(nodeA);
            expect(merged).toEqual(remoteValue);
        } finally {
            if (db) await db.close();
        }
    });

    test('replica pointer stays at x when merge is a no-op', async () => {
        // Verify the false/not-switched return value is semantically correct:
        // a no-op merge must not change the replica pointer, even in-memory.
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            // No nodes in H → no changes → no cutover.
            const L = db.schemaStorageForReplica('x');
            const H = db.hostnameSchemaStorage(hostname);
            await writeIdentifierLookup(L, []);
            await writeIdentifierLookup(H, []);
            const switched = await mergeHostIntoReplica(logger, db, hostname);
            expect(switched).toBe(false);
            expect(db.currentReplicaName()).toBe('x');
        } finally {
            if (db) await db.close();
        }
    });

    test('rejects malformed host identifiers lookup during host merge', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeA = NODE_A;
            const remoteValue = { value: { id: 'remote', type: 'test', description: 'remote value' }, isDirty: false };
            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, nodeA, TS2, [], remoteValue);
            const L = db.schemaStorageForReplica('x');
            await writeIdentifierLookup(L, entriesForSameStringNodeKeys([nodeA]));
            await H.global.put(IDENTIFIERS_KEY, 'not-an-array');

            let error;
            try {
                await mergeHostIntoReplica(logger, db, hostname);
            } catch (caught) {
                error = caught;
            }

            expect(isMalformedIdentifierLookupError(error)).toBe(true);
            expect(db.currentReplicaName()).toBe('x');
        } finally {
            if (db) await db.close();
        }
    });

    test('rejects missing host identifiers lookup during host merge', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeA = NODE_A;
            const remoteValue = { value: { id: 'remote', type: 'test', description: 'remote value' }, isDirty: false };
            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, nodeA, TS2, [], remoteValue);
            const L = db.schemaStorageForReplica('x');
            await writeIdentifierLookup(L, entriesForSameStringNodeKeys([nodeA]));

            let error;
            try {
                await mergeHostIntoReplica(logger, db, hostname);
            } catch (caught) {
                error = caught;
            }

            expect(isMissingIdentifierLookupError(error)).toBe(true);
            expect(String(error?.message)).toContain('Missing identifiers_keys_map record in staged host snapshot');
            expect(db.currentReplicaName()).toBe('x');
        } finally {
            if (db) await db.close();
        }
    });

    test('isIdentifierLookupConflictError identifies the error', () => {
        const err = new IdentifierLookupConflictError('test conflict');
        expect(isIdentifierLookupConflictError(err)).toBe(true);
        expect(isIdentifierLookupConflictError(new Error('other'))).toBe(false);
    });

    test('reconciles equal-timestamp same-key different identifiers into one strict storage identity', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const targetId = nodeIdentifierFromString('10-abcdefghi');
            const hostId = nodeIdentifierFromString('11-abcdefghi');
            const dependentId = nodeIdentifierFromString('12-abcdefghi');
            const sharedKey = stringToNodeKeyString('{"head":"shared","args":[]}');
            const dependentKey = stringToNodeKeyString('{"head":"dependent","args":[]}');
            const localValue = { value: { id: 'local', type: 'test', description: 'local' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, targetId, TS2, [], localValue);
            await L.counters.put(targetId, 7);
            await writeNode(L, dependentId, TS2, [targetId], undefined);
            await writeIdentifierLookup(L, [[targetId, sharedKey], [dependentId, dependentKey]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, hostId, TS2, [], { value: { id: 'host', type: 'test', description: 'host' }, isDirty: false });
            await H.counters.put(hostId, 9);
            await writeNode(H, dependentId, TS2, [hostId], undefined);
            await writeIdentifierLookup(H, [[hostId, sharedKey], [dependentId, dependentKey]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);
            const T = db.getSchemaStorage();
            expect(await T.values.get(targetId)).toEqual(localValue);
            for (const sublevel of [T.values, T.freshness, T.inputs, T.counters, T.timestamps]) {
                expect(await sublevel.get(hostId)).toBeUndefined();
            }
            expect(await T.inputs.get(dependentId)).toEqual({ inputs: [targetId], inputCounters: [] });
            const serialized = await T.global.get(IDENTIFIERS_KEY);
            expect(serialized).toEqual([[targetId, sharedKey], [dependentId, dependentKey]]);
        } finally {
            if (db) await db.close();
        }
    });

    test('keeps the target identifier for a target-newer semantic node', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);
            const targetId = nodeIdentifierFromString('20-abcdefghi');
            const hostId = nodeIdentifierFromString('21-abcdefghi');
            const nodeKey = stringToNodeKeyString('{"head":"newer-local","args":[]}');
            const L = db.schemaStorageForReplica('x');
            await writeNode(L, targetId, TS3, [], undefined);
            await writeIdentifierLookup(L, [[targetId, nodeKey]]);
            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, hostId, TS1, [], undefined);
            await writeIdentifierLookup(H, [[hostId, nodeKey]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);
            const T = db.getSchemaStorage();
            expect(await T.global.get(IDENTIFIERS_KEY)).toEqual([[targetId, nodeKey]]);
            expect(await T.inputs.get(targetId)).toBeDefined();
            expect(await T.inputs.get(hostId)).toBeUndefined();
        } finally {
            if (db) await db.close();
        }
    });

    test('takes the host identifier for a host-newer semantic node and removes the target identifier', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);
            const targetId = nodeIdentifierFromString('30-abcdefghi');
            const hostId = nodeIdentifierFromString('31-abcdefghi');
            const nodeKey = stringToNodeKeyString('{"head":"newer-host","args":[]}');
            const L = db.schemaStorageForReplica('x');
            await writeNode(L, targetId, TS1, [], undefined);
            await L.counters.put(targetId, 1);
            await writeIdentifierLookup(L, [[targetId, nodeKey]]);
            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, hostId, TS3, [], undefined);
            await H.counters.put(hostId, 3);
            await writeIdentifierLookup(H, [[hostId, nodeKey]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);
            const T = db.getSchemaStorage();
            expect(await T.global.get(IDENTIFIERS_KEY)).toEqual([[hostId, nodeKey]]);
            expect(await T.inputs.get(hostId)).toEqual({ inputs: [], inputCounters: [] });
            for (const sublevel of [T.values, T.freshness, T.inputs, T.counters, T.timestamps]) {
                expect(await sublevel.get(targetId)).toBeUndefined();
            }
        } finally {
            if (db) await db.close();
        }
    });

    test('lowers host-only inputs to surviving identifiers and invalidates mixed ancestry', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);
            const bId = nodeIdentifierFromString('40-abcdefghi');
            const targetCId = nodeIdentifierFromString('41-abcdefghi');
            const hostCId = nodeIdentifierFromString('42-abcdefghi');
            const hostAId = nodeIdentifierFromString('43-abcdefghi');
            const keyB = stringToNodeKeyString('{"head":"B","args":[]}');
            const keyC = stringToNodeKeyString('{"head":"C","args":[]}');
            const keyA = stringToNodeKeyString('{"head":"A","args":[]}');
            const L = db.schemaStorageForReplica('x');
            await writeNode(L, bId, TS2, [], undefined);
            await writeNode(L, targetCId, TS3, [], undefined);
            await writeIdentifierLookup(L, [[bId, keyB], [targetCId, keyC]]);
            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, bId, TS2, [], undefined);
            await writeNode(H, hostCId, TS1, [], undefined);
            await writeNode(H, hostAId, TS2, [bId, hostCId], undefined);
            await writeIdentifierLookup(H, [[bId, keyB], [hostCId, keyC], [hostAId, keyA]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);
            const T = db.getSchemaStorage();
            expect(await T.inputs.get(hostAId)).toEqual({ inputs: [bId, targetCId], inputCounters: [] });
            expect(await T.freshness.get(hostAId)).toBe('potentially-outdated');
            expect(await T.revdeps.get(targetCId)).toEqual([hostAId]);
            expect(await T.inputs.get(hostCId)).toBeUndefined();
        } finally {
            if (db) await db.close();
        }
    });

    test('invalidates a target-only node whose semantic input is taken from host', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const targetCId = nodeIdentifierFromString('50-abcdefghi');
            const hostCId = nodeIdentifierFromString('51-abcdefghi');
            const targetDId = nodeIdentifierFromString('52-abcdefghi');
            const keyC = stringToNodeKeyString('{"head":"C-target-input","args":[]}');
            const keyD = stringToNodeKeyString('{"head":"D-target-only","args":[]}');
            const targetDValue = {
                value: { id: 'd-local', type: 'test', description: 'local D' },
                isDirty: false,
            };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, targetCId, TS1, [], undefined);
            await writeNode(L, targetDId, TS2, [targetCId], targetDValue);
            await L.counters.put(targetDId, 2);
            await writeIdentifierLookup(L, [
                [targetCId, keyC],
                [targetDId, keyD],
            ]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, hostCId, TS3, [], undefined);
            await writeIdentifierLookup(H, [[hostCId, keyC]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);
            const T = db.getSchemaStorage();
            expect(await T.global.get(IDENTIFIERS_KEY)).toEqual([
                [hostCId, keyC],
                [targetDId, keyD],
            ]);
            expect(await T.inputs.get(targetDId)).toEqual({
                inputs: [hostCId],
                inputCounters: [],
            });
            expect(await T.values.get(targetDId)).toEqual(targetDValue);
            expect(await T.counters.get(targetDId)).toBe(2);
            expect(await T.freshness.get(targetDId)).toBe('potentially-outdated');
            expect(await T.revdeps.get(hostCId)).toEqual([targetDId]);
            expect(await T.inputs.get(targetCId)).toBeUndefined();
        } finally {
            if (db) await db.close();
        }
    });

    test('same semantic key with different identifiers and equal timestamps: merge succeeds, single identity survives', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const SAME_KEY = stringToNodeKeyString('{"head":"event","args":["id123"]}');
            const T_ID = nodeIdentifierFromString('1-abcdefghi');
            const H_ID = nodeIdentifierFromString('10-abcdefghi');
            const tValue = { value: { id: 'local', type: 'test', description: 'local value' }, isDirty: false };
            const hValue = { value: { id: 'remote', type: 'test', description: 'remote value' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, T_ID, TS1, [], tValue);
            await writeIdentifierLookup(L, [[T_ID, SAME_KEY]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, H_ID, TS1, [], hValue);
            await writeIdentifierLookup(H, [[H_ID, SAME_KEY]]);

            // Merge must NOT throw
            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            // Active replica stays 'x' (equal timestamps → keep → no data changes, but identifier reconciliation still counts)
            const newActive = db.currentReplicaName();
            const T = db.schemaStorageForReplica(newActive);

            // Final lookup must be a strict bijection: SAME_KEY -> T_ID only
            const serialized = await T.global.get(IDENTIFIERS_KEY);
            const finalLookup = makeIdentifierLookup(serialized ? serializeIdentifierLookup(makeIdentifierLookup(serialized)) : []);
            expect(finalLookup.keyToId.get(nodeKeyStringToString(SAME_KEY))).toBe(T_ID);
            expect(finalLookup.keyToId.size).toBe(1);
            expect(finalLookup.idToKey.size).toBe(1);

            // Target identifier data survives
            const merged = await T.values.get(T_ID);
            expect(merged).toEqual(tValue);

            // Stale host identifier must NOT be in T storage (host data was in H, not L/T)
            const hValInT = await T.values.get(H_ID);
            expect(hValInT).toBeUndefined();
            const hFreshInT = await T.freshness.get(H_ID);
            expect(hFreshInT).toBeUndefined();
            const hInputsInT = await T.inputs.get(H_ID);
            expect(hInputsInT).toBeUndefined();
            const hCounterInT = await T.counters.get(H_ID);
            expect(hCounterInT).toBeUndefined();
            const hTsInT = await T.timestamps.get(H_ID);
            expect(hTsInT).toBeUndefined();
        } finally {
            if (db) await db.close();
        }
    });

    test('same semantic key with different identifiers and target-newer: keep, target id survives', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const SAME_KEY = stringToNodeKeyString('{"head":"event","args":["id456"]}');
            const T_ID = nodeIdentifierFromString('2-abcdefghi');
            const H_ID = nodeIdentifierFromString('20-abcdefghi');
            const tValue = { value: { id: 'local', type: 'test', description: 'local newer' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, T_ID, TS3, [], tValue);
            await writeIdentifierLookup(L, [[T_ID, SAME_KEY]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, H_ID, TS1, [], undefined);
            await writeIdentifierLookup(H, [[H_ID, SAME_KEY]]);

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const T = db.schemaStorageForReplica(db.currentReplicaName());

            // Final lookup: SAME_KEY -> T_ID
            const raw = await T.global.get(IDENTIFIERS_KEY);
            const finalLookup = raw ? makeIdentifierLookup(raw) : null;
            const keyStr = nodeKeyStringToString(SAME_KEY);
            expect(finalLookup ? finalLookup.keyToId.get(keyStr) : undefined).toBe(T_ID);
            expect(finalLookup ? finalLookup.keyToId.size : 0).toBe(1);

            // Host identifier NOT in final lookup
            expect(finalLookup ? finalLookup.idToKey.has(nodeIdentifierToString(H_ID)) : false).toBe(false);

            // Target identifier data survives
            const val = await T.values.get(T_ID);
            expect(val).toEqual(tValue);
        } finally {
            if (db) await db.close();
        }
    });

    test('same semantic key with different identifiers and host-newer: take, host id survives, target id removed', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const SAME_KEY = stringToNodeKeyString('{"head":"event","args":["id789"]}');
            const T_ID = nodeIdentifierFromString('3-abcdefghi');
            const H_ID = nodeIdentifierFromString('30-abcdefghi');
            const tValue = { value: { id: 'local', type: 'test', description: 'local older' }, isDirty: false };
            const hValue = { value: { id: 'remote', type: 'test', description: 'remote newer' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, T_ID, TS1, [], tValue);
            await writeIdentifierLookup(L, [[T_ID, SAME_KEY]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, H_ID, TS3, [], hValue);
            await writeIdentifierLookup(H, [[H_ID, SAME_KEY]]);

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const newActive = db.currentReplicaName();
            expect(newActive).toBe('y');
            const T = db.schemaStorageForReplica(newActive);

            // Final lookup: SAME_KEY -> H_ID (host identifier survives)
            const raw = await T.global.get(IDENTIFIERS_KEY);
            const finalLookup = raw ? makeIdentifierLookup(raw) : null;
            const keyStr = nodeKeyStringToString(SAME_KEY);
            expect(finalLookup ? finalLookup.keyToId.get(keyStr) : undefined).toBe(H_ID);
            expect(finalLookup ? finalLookup.keyToId.size : 0).toBe(1);
            expect(finalLookup ? finalLookup.idToKey.size : 0).toBe(1);

            // Host identifier data is in T (copied from H)
            const valAtH = await T.values.get(H_ID);
            expect(valAtH).toEqual(hValue);

            // Losing target identifier must be removed from T storage
            const valAtT = await T.values.get(T_ID);
            expect(valAtT).toBeUndefined();
            const freshAtT = await T.freshness.get(T_ID);
            expect(freshAtT).toBeUndefined();
            const inputsAtT = await T.inputs.get(T_ID);
            expect(inputsAtT).toBeUndefined();
            const counterAtT = await T.counters.get(T_ID);
            expect(counterAtT).toBeUndefined();
            const tsAtT = await T.timestamps.get(T_ID);
            expect(tsAtT).toBeUndefined();
        } finally {
            if (db) await db.close();
        }
    });

    test('H-only node depending on semantic node whose target id survives: inputs lowered, potentially-outdated', async () => {
        // Graph: A depends on B and C.
        // Target has B (tId) and C (C_t).
        // Host has B (hId, same key but different id), C (C_h, same key but different id),
        //   and A (A_h) depending on [B, C_h].
        // Merge keeps target's C_t (equal timestamps → keep).
        // A is taken (host-only), but its inputs are lowered so it depends on [B_final, C_t].
        // A is marked potentially-outdated because it was computed with C_h, not C_t.
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const KEY_A = stringToNodeKeyString('{"head":"A","args":[]}');
            const KEY_B = stringToNodeKeyString('{"head":"B","args":[]}');
            const KEY_C = stringToNodeKeyString('{"head":"C","args":[]}');

            const B_T_ID = nodeIdentifierFromString('1-abcdefghi');
            const C_T_ID = nodeIdentifierFromString('2-abcdefghi');
            const B_H_ID = nodeIdentifierFromString('11-abcdefghi');
            const C_H_ID = nodeIdentifierFromString('22-abcdefghi');
            const A_H_ID = nodeIdentifierFromString('33-abcdefghi');

            const tValB = { value: { id: 'b', type: 'test' }, isDirty: false };
            const tValC = { value: { id: 'c', type: 'test' }, isDirty: false };
            const hValA = { value: { id: 'a', type: 'test' }, isDirty: false };

            // Target (L) has B at B_T_ID (same ts), C at C_T_ID (newer → force-keep)
            const L = db.schemaStorageForReplica('x');
            await writeNode(L, B_T_ID, TS1, [], tValB);
            await writeNode(L, C_T_ID, TS3, [], tValC);
            await writeIdentifierLookup(L, [
                [B_T_ID, KEY_B],
                [C_T_ID, KEY_C],
            ]);

            // Host (H) has B at B_H_ID, C at C_H_ID, A at A_H_ID depending on [B_H_ID, C_H_ID]
            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, B_H_ID, TS1, [], undefined);
            await writeNode(H, C_H_ID, TS1, [], undefined);
            await writeNode(H, A_H_ID, TS2, [B_H_ID, C_H_ID], hValA);
            await writeIdentifierLookup(H, [
                [B_H_ID, KEY_B],
                [C_H_ID, KEY_C],
                [A_H_ID, KEY_A],
            ]);

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const T = db.schemaStorageForReplica(db.currentReplicaName());

            // A must exist and have been taken
            const aValue = await T.values.get(A_H_ID);
            expect(aValue).toEqual(hValA);

            // A's freshness: potentially-outdated (computed with C_h, but C_t survived)
            const aFreshness = await T.freshness.get(A_H_ID);
            expect(aFreshness).toBe('potentially-outdated');

            // A's inputs must be lowered: should reference final identifiers for B and C
            // B keep → B_T_ID survives, C keep → C_T_ID survives
            const aInputs = await T.inputs.get(A_H_ID);
            expect(aInputs).not.toBeUndefined();
            const loweredInputStrings = aInputs ? aInputs.inputs.map(id => String(id)) : [];
            expect(loweredInputStrings).toContain(String(B_T_ID));
            expect(loweredInputStrings).toContain(String(C_T_ID));
            // Must NOT contain host identifiers
            expect(loweredInputStrings).not.toContain(String(B_H_ID));
            expect(loweredInputStrings).not.toContain(String(C_H_ID));

            // Revdeps should point from B_T_ID and C_T_ID to A_H_ID
            const bRevdeps = await T.revdeps.get(B_T_ID);
            expect(bRevdeps).not.toBeUndefined();
            expect(bRevdeps ? bRevdeps.map(d => String(d)) : []).toContain(String(A_H_ID));
            const cRevdeps = await T.revdeps.get(C_T_ID);
            expect(cRevdeps).not.toBeUndefined();
            expect(cRevdeps ? cRevdeps.map(d => String(d)) : []).toContain(String(A_H_ID));

            // Final lookup must be a strict bijection
            const raw = await T.global.get(IDENTIFIERS_KEY);
            const finalLookup = raw ? makeIdentifierLookup(raw) : null;
            expect(finalLookup ? finalLookup.keyToId.size : 0).toBe(finalLookup ? finalLookup.idToKey.size : 0);
            // B → B_T_ID, C → C_T_ID, A → A_H_ID
            expect(finalLookup ? finalLookup.keyToId.get(nodeKeyStringToString(KEY_B)) : undefined).toBe(B_T_ID);
            expect(finalLookup ? finalLookup.keyToId.get(nodeKeyStringToString(KEY_C)) : undefined).toBe(C_T_ID);
            expect(finalLookup ? finalLookup.keyToId.get(nodeKeyStringToString(KEY_A)) : undefined).toBe(A_H_ID);

            // B_T_ID and C_T_ID data should still be in T
            expect(await T.values.get(B_T_ID)).toBeDefined();
            expect(await T.values.get(C_T_ID)).toBeDefined();
        } finally {
            if (db) await db.close();
        }
    });

    test('mixed ancestry invalidation works with semantic-key-based planner', async () => {
        // Same scenario as the existing invalidation test, but using different identifiers
        // for the same key on the two sides.
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const KEY_A = stringToNodeKeyString('{"head":"A","args":[]}');
            const KEY_B = stringToNodeKeyString('{"head":"B","args":[]}');

            const A_T_ID = nodeIdentifierFromString('1-abcdefghi');
            const B_T_ID = nodeIdentifierFromString('2-abcdefghi');
            const A_H_ID = nodeIdentifierFromString('11-abcdefghi');
            const B_H_ID = nodeIdentifierFromString('22-abcdefghi');

            const localValueB = { value: { id: 'b-local', type: 'test', description: 'local B' }, isDirty: false };
            const remoteValueB = { value: { id: 'b-remote', type: 'test', description: 'remote B' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            // A is force-kept (T-newer); B is initially 'take' (H-newer) and depends on A
            await writeNode(L, A_T_ID, TS3, [], undefined);
            await writeNode(L, B_T_ID, TS1, [], localValueB);
            await L.counters.put(B_T_ID, 1);
            await writeIdentifierLookup(L, [
                [A_T_ID, KEY_A],
                [B_T_ID, KEY_B],
            ]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, A_H_ID, TS1, [], undefined);
            await writeNode(H, B_H_ID, TS2, [A_H_ID], remoteValueB);
            await H.counters.put(B_H_ID, 2);
            await writeIdentifierLookup(H, [
                [A_H_ID, KEY_A],
                [B_H_ID, KEY_B],
            ]);

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const T = db.schemaStorageForReplica(db.currentReplicaName());

            // A is keep → A_T_ID survives
            // B is initially take → B_H_ID should carry the data; but invalidated
            // B should be invalidated: both keepTainted (via A) and takeTainted (B itself)
            const bFreshness = await T.freshness.get(B_H_ID);
            expect(bFreshness).toBe('potentially-outdated');

            // B's stored inputs should point to final identifiers (A_T_ID, not A_H_ID)
            const bInputs = await T.inputs.get(B_H_ID);
            expect(bInputs).not.toBeUndefined();
            expect(bInputs ? bInputs.inputs.map(id => String(id)) : []).toEqual([String(A_T_ID)]);

            // B's counter and value from H should be preserved
            const bCounter = await T.counters.get(B_H_ID);
            expect(bCounter).toBe(2);
            const bValue = await T.values.get(B_H_ID);
            expect(bValue).toEqual(remoteValueB);

            // B's modifiedAt advanced to H's TS2
            const bTimestamps = await T.timestamps.get(B_H_ID);
            expect(bTimestamps?.modifiedAt).toBe(TS2);
        } finally {
            if (db) await db.close();
        }
    });

    test('same identifier mapped to different semantic keys remains a hard error', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const idA = nodeIdentifierFromString('1-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"event","args":["a"]}');
            const keyB = stringToNodeKeyString('{"head":"event","args":["b"]}');

            const L = db.schemaStorageForReplica('x');
            await writeIdentifierLookup(L, [[idA, keyA]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeIdentifierLookup(H, [[idA, keyB]]);

            let error;
            try {
                await mergeHostIntoReplica(logger, db, hostname);
            } catch (caught) {
                error = caught;
            }

            expect(isIdentifierLookupConflictError(error)).toBe(true);
            expect(String(error?.message)).toContain('Conflicting node key assignment for identifier');
            expect(db.currentReplicaName()).toBe('x');
        } finally {
            if (db) await db.close();
        }
    });

    test('identifier-only reconciliation causes replica cutover', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const SAME_KEY = stringToNodeKeyString('{"head":"event","args":["cutover-test"]}');
            const T_ID = nodeIdentifierFromString('1-abcdefghi');
            const H_ID = nodeIdentifierFromString('10-abcdefghi');

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, T_ID, TS1, [], { value: { id: 'val' }, isDirty: false });
            await writeIdentifierLookup(L, [[T_ID, SAME_KEY]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, H_ID, TS1, [], { value: { id: 'val' }, isDirty: false });
            await writeIdentifierLookup(H, [[H_ID, SAME_KEY]]);

            // Precondition: active replica is 'x'
            expect(db.currentReplicaName()).toBe('x');

            const switched = await mergeHostIntoReplica(logger, db, hostname);

            // Even though no graph data changed (equal timestamps → keep),
            // identifier reconciliation means the merge IS a change:
            // the final lookup must be committed and the replica must be switched.
            expect(switched).toBe(true);
        } finally {
            if (db) await db.close();
        }
    });

    test('throws MissingInputIdentifierError when node depends on identifier not in any lookup', async () => {
        // Corrupt graph: host has a node whose inputs reference an identifier
        // that is missing from both lookups.  The planner must throw instead
        // of silently dropping the dependency.
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const keyA = stringToNodeKeyString('{"head":"A","args":[]}');
            const A_T_ID = nodeIdentifierFromString('1-abcdefghi');
            const B_H_ID = nodeIdentifierFromString('2-abcdefghi');
            const MYSTERY_ID = nodeIdentifierFromString('99-abcdefghi');
            const keyB = stringToNodeKeyString('{"head":"B","args":[]}');

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, A_T_ID, TS1, [], undefined);
            await writeIdentifierLookup(L, [[A_T_ID, keyA]]);

            const H = db.hostnameSchemaStorage(hostname);
            // B depends on MYSTERY_ID, which is NOT in either lookup.
            await writeNode(H, B_H_ID, TS2, [MYSTERY_ID], undefined);
            await writeIdentifierLookup(H, [[B_H_ID, keyB]]);

            let error;
            try {
                await mergeHostIntoReplica(logger, db, hostname);
            } catch (caught) {
                error = caught;
            }

            expect(isIdentifierLookupConflictError(error)).toBe(true);
            expect(String(error?.message)).toContain(String(MYSTERY_ID));
            expect(db.currentReplicaName()).toBe('x');
        } finally {
            if (db) await db.close();
        }
    });

    test('target-only nodes remain keep despite taint from host-newer ancestor', async () => {
        // Scenario:
        //   Target: A_t (key K) TS1, D_t (key K2) TS1, inputs=[A_t]
        //   Host:   A_h (key K) TS3 (newer), no D
        // A is shared, host-newer → take (A_h wins). D is target-only → keep.
        // Without the fix, D inherits takeTainted from A and becomes 'take',
        // which copies from non-existent host storage, losing D's data.
        // After the fix, D stays 'keep' with its data preserved and inputs
        // lowered to the final identifier for A (A_h).
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const KEY_A = stringToNodeKeyString('{"head":"A","args":[]}');
            const KEY_D = stringToNodeKeyString('{"head":"D","args":[]}');
            const A_T_ID = nodeIdentifierFromString('1-abcdefghi');
            const A_H_ID = nodeIdentifierFromString('11-abcdefghi');
            const D_T_ID = nodeIdentifierFromString('2-abcdefghi');
            const targetValueD = { value: { id: 'd-target', type: 'test', description: 'target-only D' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, A_T_ID, TS1, [], undefined);
            await writeNode(L, D_T_ID, TS1, [A_T_ID], targetValueD);
            await writeIdentifierLookup(L, [
                [A_T_ID, KEY_A],
                [D_T_ID, KEY_D],
            ]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, A_H_ID, TS3, [], undefined);
            await writeIdentifierLookup(H, [[A_H_ID, KEY_A]]);

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const T = db.schemaStorageForReplica(db.currentReplicaName());

            // D_T_ID must still exist (data preserved)
            const dValue = await T.values.get(D_T_ID);
            expect(dValue).toEqual(targetValueD);
            const dFreshness = await T.freshness.get(D_T_ID);
            expect(dFreshness).toBeDefined();

            // D's inputs must be lowered: they should reference A_H_ID (final ident for key A)
            const dInputs = await T.inputs.get(D_T_ID);
            expect(dInputs).not.toBeUndefined();
            const loweredDInputs = dInputs ? dInputs.inputs.map(id => String(id)) : [];
            expect(loweredDInputs).toContain(String(A_H_ID));

            // A_T_ID should be gone (losing target identifier deleted)
            const aTVal = await T.values.get(A_T_ID);
            expect(aTVal).toBeUndefined();

            // Final lookup must be a strict bijection: A→A_H_ID, D→D_T_ID
            const raw = await T.global.get(IDENTIFIERS_KEY);
            const finalLookup = raw ? makeIdentifierLookup(raw) : null;
            const keyStrA = nodeKeyStringToString(KEY_A);
            const keyStrD = nodeKeyStringToString(KEY_D);
            expect(finalLookup ? finalLookup.keyToId.get(keyStrA) : undefined).toBe(A_H_ID);
            expect(finalLookup ? finalLookup.keyToId.get(keyStrD) : undefined).toBe(D_T_ID);
            expect(finalLookup ? finalLookup.keyToId.size : 0).toBe(2);
        } finally {
            if (db) await db.close();
        }
    });

    test('kept node with changed dependency identifier gets inputs rewritten', async () => {
        // Scenario:
        //   Target: A_t (key K) TS1, B_t (key K2) TS1, inputs=[A_t]
        //   Host:   A_h (key K) TS3 (newer), no B
        // A is shared, host-newer → take (A_h wins). B is target-only → force-kept.
        // B's stored inputs=[A_t] must be rewritten to=[A_h] because A_h is the
        // final identifier for key K. Without the fix, B's inputs still point to
        // the deleted A_t identifier.
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const KEY_A = stringToNodeKeyString('{"head":"A","args":[]}');
            const KEY_B = stringToNodeKeyString('{"head":"B","args":[]}');
            const A_T_ID = nodeIdentifierFromString('1-abcdefghi');
            const A_H_ID = nodeIdentifierFromString('11-abcdefghi');
            const B_T_ID = nodeIdentifierFromString('2-abcdefghi');

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, A_T_ID, TS1, [], undefined);
            await writeNode(L, B_T_ID, TS1, [A_T_ID], undefined);
            await writeIdentifierLookup(L, [
                [A_T_ID, KEY_A],
                [B_T_ID, KEY_B],
            ]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, A_H_ID, TS3, [], undefined);
            await writeIdentifierLookup(H, [[A_H_ID, KEY_A]]);

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const T = db.schemaStorageForReplica(db.currentReplicaName());

            // B_T_ID's inputs must be rewritten to reference A_H_ID (not A_T_ID)
            const bInputs = await T.inputs.get(B_T_ID);
            expect(bInputs).not.toBeUndefined();
            const loweredBInputs = bInputs ? bInputs.inputs.map(id => String(id)) : [];
            expect(loweredBInputs).toContain(String(A_H_ID));
            expect(loweredBInputs).not.toContain(String(A_T_ID));

            // B must still exist (its identifier unchanged)
            const bFreshness = await T.freshness.get(B_T_ID);
            expect(bFreshness).toBeDefined();
        } finally {
            if (db) await db.close();
        }
    });

    test('throws IdentifierLookupConflictError when same identifier maps to different semantic keys', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const idA = nodeIdentifierFromString('1-abcdefghi');
            const idB = nodeIdentifierFromString('2-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"event","args":["a"]}');
            const keyB = stringToNodeKeyString('{"head":"event","args":["b"]}');
            const keyC = stringToNodeKeyString('{"head":"event","args":["c"]}');

            const L = db.schemaStorageForReplica('x');
            await writeIdentifierLookup(L, [
                [idA, keyA],
                [idB, keyB],
            ]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeIdentifierLookup(H, [
                [idA, keyA],
                [idB, keyC],
            ]);

            let error;
            try {
                await mergeHostIntoReplica(logger, db, hostname);
            } catch (caught) {
                error = caught;
            }

            expect(isIdentifierLookupConflictError(error)).toBe(true);
            expect(String(error?.message)).toContain('Conflicting node key assignment for identifier');
            expect(String(error?.message)).toContain(String(idB));
            expect(String(error?.message)).toContain('Volodyslav will not resolve this automatically');
            expect(String(error?.message)).toContain('manually fix the identifiers_keys_map records');
            expect(db.currentReplicaName()).toBe('x');
        } finally {
            if (db) await db.close();
        }
    });
});
