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

    test('throws readable error on conflicting identifier assignments for same semantic key', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const targetParent = nodeIdentifierFromString('6-abcdefghi');
            const targetChild = nodeIdentifierFromString('7-abcdefghi');
            const hostParent = nodeIdentifierFromString('8-abcdefghi');
            const hostChild = nodeIdentifierFromString('9-abcdefghi');
            const parentKey = stringToNodeKeyString('{"head":"parent","args":[]}');
            const childKey = stringToNodeKeyString('{"head":"child","args":[]}');
            const L = db.schemaStorageForReplica('x');
            await writeNode(L, targetParent, TS1, [], undefined);
            await writeNode(L, targetChild, TS1, [targetParent], undefined);
            await writeIdentifierLookup(L, [
                [targetParent, parentKey],
                [targetChild, childKey],
            ]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeNode(H, hostParent, TS1, [], undefined);
            await writeNode(H, hostChild, TS2, [hostParent], undefined);
            await writeIdentifierLookup(H, [
                [hostParent, parentKey],
                [hostChild, childKey],
            ]);

            let error;
            try {
                await mergeHostIntoReplica(logger, db, hostname);
            } catch (caught) {
                error = caught;
            }

            expect(isIdentifierLookupConflictError(error)).toBe(true);
            expect(String(error?.message)).toContain('Conflicting identifier assignment for node key');
            expect(String(error?.message)).toContain(String(parentKey));
            expect(String(error?.message)).toContain('Volodyslav will not resolve this automatically');
            expect(String(error?.message)).toContain('manually fix the identifiers_keys_map records');

            expect(db.currentReplicaName()).toBe('x');
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

            // The H-only node was taken; buildTakeOps emits delOp for missing timestamps.
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
