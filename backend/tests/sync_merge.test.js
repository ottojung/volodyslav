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
    GRAPH_SCHEME_KEY,
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
    assertValidFinalMergeState,
    FinalMergeStateError,
} = require('../src/generators/incremental_graph/database/sync_merge_validation');
const { createIncrementalGraph } = require('../src/generators/incremental_graph');
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
async function writeNode(storage, nodeKey, modifiedAt, valuePayload) {
    await storage.timestamps.put(nodeKey, { createdAt: modifiedAt, modifiedAt });
    await storage.freshness.put(nodeKey, 'up-to-date');
    await storage.values.put(nodeKey, valuePayload ?? {});
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
        stringToNodeKeyString(JSON.stringify({ head: "test", args: [String(nodeIdentifier)] })),
    ]);
}

/**
 * Write a comprehensive graph scheme covering heads used across all tests.
 * @param {import('../src/generators/incremental_graph/database').SchemaStorage} storage
 */
async function writeGraphScheme(storage) {
    const scheme = {
        format: 1,
        nodes: [
            { head: "A", arity: 0, inputTemplates: [{ head: "B", args: [] }, { head: "C", args: [] }] },
            { head: "A_missing_valid", arity: 0, inputTemplates: [] },
            { head: "A_precise", arity: 0, inputTemplates: [] },
            { head: "A_required_flag", arity: 0, inputTemplates: [] },
            { head: "A_taken", arity: 0, inputTemplates: [] },
            { head: "A_stale", arity: 0, inputTemplates: [] },
            { head: "A_stale_preserve", arity: 0, inputTemplates: [] },
            { head: "A_unrelated", arity: 0, inputTemplates: [] },
            { head: "A_value_change", arity: 0, inputTemplates: [] },
            { head: "B", arity: 0, inputTemplates: [] },
            { head: "B_missing_valid", arity: 0, inputTemplates: [{ head: "A_missing_valid", args: [] }] },
            { head: "B_precise", arity: 0, inputTemplates: [{ head: "A_precise", args: [] }] },
            { head: "B_required_flag", arity: 0, inputTemplates: [{ head: "A_required_flag", args: [] }] },
            { head: "B_stale", arity: 0, inputTemplates: [{ head: "A_stale", args: [] }] },
            { head: "B_stale_preserve", arity: 0, inputTemplates: [{ head: "A_stale_preserve", args: [] }] },
            { head: "B_unrelated", arity: 0, inputTemplates: [{ head: "A_unrelated", args: [] }] },
            { head: "B_taken", arity: 0, inputTemplates: [{ head: "A_taken", args: [] }] },
            { head: "B_value_change", arity: 0, inputTemplates: [{ head: "A_value_change", args: [] }] },
            { head: "C_honly", arity: 0, inputTemplates: [{ head: "P_honly", args: [] }] },
            { head: "C", arity: 0, inputTemplates: [] },
            { head: "C-target-input", arity: 0, inputTemplates: [] },
            { head: "C_precise", arity: 0, inputTemplates: [] },
            { head: "C_extra", arity: 0, inputTemplates: [] },
            { head: "host_stale_A", arity: 0, inputTemplates: [] },
            { head: "host_stale_B", arity: 0, inputTemplates: [{ head: "host_stale_A", args: [] }] },
            { head: "host_stale_C", arity: 0, inputTemplates: [{ head: "host_stale_B", args: [] }] },
            { head: "cross_A", arity: 0, inputTemplates: [] },
            { head: "cross_B", arity: 0, inputTemplates: [{ head: "cross_A", args: [] }] },
            { head: "ident_A", arity: 0, inputTemplates: [] },
            { head: "ident_B", arity: 0, inputTemplates: [{ head: "ident_A", args: [] }] },
            { head: "del_A", arity: 0, inputTemplates: [] },
            { head: "del_B", arity: 0, inputTemplates: [{ head: "del_A", args: [] }] },
            { head: "prop_A", arity: 0, inputTemplates: [] },
            { head: "prop_B", arity: 0, inputTemplates: [{ head: "prop_A", args: [] }] },
            { head: "prop_C", arity: 0, inputTemplates: [{ head: "prop_B", args: [] }] },
            { head: "stale_input_A", arity: 0, inputTemplates: [] },
            { head: "stale_input_B", arity: 0, inputTemplates: [{ head: "stale_input_A", args: [] }] },
            { head: "D-target-only", arity: 0, inputTemplates: [{ head: "C-target-input", args: [] }] },
            { head: "D_precise", arity: 0, inputTemplates: [{ head: "C_precise", args: [] }] },
            { head: "X_stale_preserve", arity: 0, inputTemplates: [] },
            { head: "X_unrelated", arity: 0, inputTemplates: [] },
            { head: "a_counter_collision", arity: 0, inputTemplates: [{ head: "c_counter_collision", args: [] }] },
            { head: "a_transitive_relower", arity: 0, inputTemplates: [{ head: "c_transitive_relower", args: [] }] },
            { head: "c_counter_collision", arity: 0, inputTemplates: [] },
            { head: "c_transitive_relower", arity: 0, inputTemplates: [] },
            { head: "child", arity: 0, inputTemplates: [{ head: "parent", args: [] }] },
            { head: "d_transitive_relower", arity: 0, inputTemplates: [{ head: "a_transitive_relower", args: [] }] },
            { head: "dependent", arity: 0, inputTemplates: [{ head: "shared", args: [] }] },
            { head: "event", arity: 1, inputTemplates: [] },
            { head: "P_honly", arity: 0, inputTemplates: [] },
            { head: "newer-host", arity: 0, inputTemplates: [] },
            { head: "newer-local", arity: 0, inputTemplates: [] },
            { head: "parent", arity: 0, inputTemplates: [] },
            { head: "shared", arity: 0, inputTemplates: [] },
            { head: "test", arity: 1, inputTemplates: [] },
        ],
    };
    await storage.global.put(GRAPH_SCHEME_KEY, JSON.stringify(scheme));
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
            await writeGraphScheme(db.schemaStorageForReplica('x'));
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

    test('rejects merge when version matches but graph_scheme differs', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeId = nodeIdentifierFromString('137-abcdefghi');
            const nodeKey = stringToNodeKeyString('{"head":"X","args":[]}');

            // Write scheme A on local
            const L = db.schemaStorageForReplica('x');
            await L.global.put(GRAPH_SCHEME_KEY, JSON.stringify({
                format: 1,
                nodes: [{ head: "X", arity: 0, inputTemplates: [] }],
            }));
            await writeIdentifierLookup(L, [[nodeId, nodeKey]]);

            // Write different scheme B on host
            const H = db.hostnameSchemaStorage(hostname);
            await H.global.put(GRAPH_SCHEME_KEY, JSON.stringify({
                format: 1,
                nodes: [{ head: "Y", arity: 0, inputTemplates: [] }],
            }));
            await writeIdentifierLookup(H, []);

            await expect(
                mergeHostIntoReplica(logger, db, hostname)
            ).rejects.toThrow(/different graph_scheme/);
        } finally {
            if (db) await db.close();
        }
    });

    test('accepts merge when version and graph_scheme both match', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeId = nodeIdentifierFromString('138-abcdefghi');
            const nodeKey = stringToNodeKeyString('{"head":"X","args":[]}');

            // Write identical scheme on both sides
            const scheme = {
                format: 1,
                nodes: [{ head: "X", arity: 0, inputTemplates: [] }],
            };
            const L = db.schemaStorageForReplica('x');
            await L.global.put(GRAPH_SCHEME_KEY, JSON.stringify(scheme));
            await writeIdentifierLookup(L, [[nodeId, nodeKey]]);

            const H = db.hostnameSchemaStorage(hostname);
            await H.global.put(GRAPH_SCHEME_KEY, JSON.stringify(scheme));
            await writeIdentifierLookup(H, []);

            // Merge succeeds because no host node data exists.
            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(false);
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
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeA = NODE_A;
            const localValue = { value: { id: 'local', type: 'test', description: 'local value' }, isDirty: false };
            const remoteValue = { value: { id: 'remote', type: 'test', description: 'remote value' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            await writeGraphScheme(L);
            await writeNode(L, nodeA, TS1, localValue);
            await writeIdentifierLookup(L, entriesForSameStringNodeKeys([nodeA]));

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeA, TS1, remoteValue);
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
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeA = NODE_A;
            const localValue = { value: { id: 'local', type: 'test', description: 'local value' }, isDirty: false };
            const remoteValue = { value: { id: 'remote', type: 'test', description: 'remote value' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeA, TS1, localValue);
            await writeIdentifierLookup(L, entriesForSameStringNodeKeys([nodeA]));
            // Write stale validity flags to L before merge
            await L.valid.put(nodeA, [NODE_B]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeA, TS2, remoteValue);
            await writeIdentifierLookup(H, entriesForSameStringNodeKeys([nodeA]));

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const newActive = db.currentReplicaName();
            expect(newActive).toBe('y');

            const T = db.schemaStorageForReplica(newActive);
            const merged = await T.values.get(nodeA);
            expect(merged).toEqual(remoteValue);

            // This changed merge takes a zero-input node. There are no
            // incoming validity edges to preserve or rebuild.
            const validKeys = [];
            for await (const key of T.valid.keys()) {
                validKeys.push(key);
            }
            expect(validKeys).toEqual([]);
        } finally {
            if (db) await db.close();
        }
    });

    test('kept merge preserves local validity state', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeA = NODE_A;
            const localValue = { value: { id: 'local', type: 'test', description: 'local value' }, isDirty: false };
            const remoteValue = { value: { id: 'remote', type: 'test', description: 'remote value' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeA, TS1, localValue);
            await writeIdentifierLookup(L, entriesForSameStringNodeKeys([nodeA]));
            // Write valid flags to L before merge

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeA, TS1, remoteValue);
            await writeIdentifierLookup(H, entriesForSameStringNodeKeys([nodeA]));

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            // Equal timestamps: keep decision, no changes, replica pointer stays
            const newActive = db.currentReplicaName();
            expect(newActive).toBe('x');

            const T = db.schemaStorageForReplica(newActive);
            const kept = await T.values.get(nodeA);
            expect(kept).toEqual(localValue);
            const validKeys = [];
            for await (const key of T.valid.keys()) {
                validKeys.push(key);
            }
            expect(validKeys).toEqual([]);
        } finally {
            if (db) await db.close();
        }
    });

    test('reconciles different identifiers across multiple semantic nodes', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
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
            await writeNode(L, targetParent, TS1, undefined);
            await writeNode(L, targetChild, TS1, undefined);
            await writeIdentifierLookup(L, [[targetParent, parentKey], [targetChild, childKey]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, hostParent, TS1, undefined);
            await writeNode(H, hostChild, TS2, undefined);
            await writeIdentifierLookup(H, [[hostParent, parentKey], [hostChild, childKey]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);
            const T = db.getSchemaStorage();
            expect(await T.global.get(IDENTIFIERS_KEY)).toEqual([
                [targetParent, parentKey],
                [hostChild, childKey],
            ]);
            // Child's structural dependency on parent changed from hostParent to
            // targetParent, making it directly relowered. Its value is deleted
            // and freshness becomes potentially-outdated.
            expect(await T.freshness.get(hostChild)).toBe('potentially-outdated');
            expect(await T.values.get(hostChild)).toBeUndefined();
            expect(await T.values.get(targetChild)).toBeUndefined();
            expect(await T.values.get(hostParent)).toBeUndefined();
        } finally {
            if (db) await db.close();
        }
    });

    test('H-only node (not in L) is taken and added to merged replica', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeA = NODE_A;
            const remoteValue = { value: { id: 'h-only', type: 'test', description: 'h only' }, isDirty: false };

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeA, TS1, remoteValue);
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
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeP = NODE_P;  // shared node; T is newer (force-keep)
            const nodeC = NODE_C;  // H-only node that depends on P
            const keyP = stringToNodeKeyString('{"head":"P_honly","args":[]}');
            const keyC = stringToNodeKeyString('{"head":"C_honly","args":[]}');

            const localPValue = { value: { id: 'p-local', type: 'test', description: 'newer local P' }, isDirty: false };
            const remoteCValue = { value: { id: 'c-remote', type: 'test', description: 'stale remote C' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            // P: T has a strictly newer timestamp → force-keep
            await writeNode(L, nodeP, TS3, localPValue);
            await writeIdentifierLookup(L, [[nodeP, keyP]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            // P in H is older
            await writeNode(H, nodeP, TS1, undefined);
            // C is only in H; it depends on P (computed from H's stale P)
            await writeNode(H, nodeC, TS2, remoteCValue);
            await writeIdentifierLookup(H, [[nodeP, keyP], [nodeC, keyC]]);

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

    test('missing timestamps in H reject merge before active replica changes', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            // Write an H-only node without a timestamps record.
            const hOnlyNode = NODE_H;
            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await H.values.put(hOnlyNode, {});
            await H.freshness.put(hOnlyNode, 'up-to-date');
            const L = db.schemaStorageForReplica('x');
            await writeIdentifierLookup(L, []);
            await writeIdentifierLookup(H, entriesForSameStringNodeKeys([hOnlyNode]));

            await expect(mergeHostIntoReplica(logger, db, hostname)).rejects.toThrow(IdentifierLookupConflictError);
            expect(db.currentReplicaName()).toBe('x');
        } finally {
            if (db) await db.close();
        }
    });

    test('replica pointer does not switch after no-op merge', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const before = db.currentReplicaName();
            expect(before).toBe('x');
            const L = db.schemaStorageForReplica('x');
            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
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
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeA = NODE_A;
            const nodeB = NODE_B;
            const keyA = stringToNodeKeyString('{"head":"A_taken","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"B_taken","args":[]}');
            const localValueB = { value: { id: 'b-local', type: 'test', description: 'local B' }, isDirty: false };
            const remoteValueB = { value: { id: 'b-remote', type: 'test', description: 'remote B' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            // In T: A is force-kept (T-newer); B has no deps (independent of A).
            await writeNode(L, nodeA, TS3, undefined);
            await writeNode(L, nodeB, TS1, localValueB);
            await writeIdentifierLookup(L, [[nodeA, keyA], [nodeB, keyB]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            // In H: A is older; B is newer AND now depends on A.
            await writeNode(H, nodeA, TS1, undefined);
            await writeNode(H, nodeB, TS2, remoteValueB);
            await writeIdentifierLookup(H, [[nodeA, keyA], [nodeB, keyB]]);

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const newActive = db.currentReplicaName();
            const T = db.schemaStorageForReplica(newActive);

            // B should be 'invalidate' because its merged inputs include the
            // force-kept A, making it keepTainted AND takeTainted.
            const bFreshness = await T.freshness.get(nodeB);
            expect(bFreshness).toBe('potentially-outdated');

            // Because initial decision for B was 'take', invalidate must still
            // apply H's structural state so inputs/valid remain consistent.
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
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeA = NODE_A;
            const nodeB = NODE_B;
            const keyA = stringToNodeKeyString('{"head":"A_taken","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"B_taken","args":[]}');
            const localValueB = { value: { id: 'b-local', type: 'test', description: 'local B' }, isDirty: false };
            const remoteValueB = { value: { id: 'b-remote', type: 'test', description: 'remote B' }, isDirty: false };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeA, TS3, undefined);
            await writeNode(L, nodeB, TS1, localValueB);
            await writeIdentifierLookup(L, [[nodeA, keyA], [nodeB, keyB]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeA, TS1, undefined);
            await writeNode(H, nodeB, TS2, remoteValueB);
            await writeIdentifierLookup(H, [[nodeA, keyA], [nodeB, keyB]]);

            // First merge: B is 'invalidate', modifiedAt advanced to TS2.
            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            // Restore the same H staging data for the second merge
            // (simulates a re-sync against the same remote snapshot).
            // Re-write H since clearHostnameStorage may have been called by caller
            // in production; in this test we write it directly.
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);
            const H2 = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H2);
            await writeNode(H2, nodeA, TS1, undefined);
            await writeNode(H2, nodeB, TS2, remoteValueB);
            await writeIdentifierLookup(H2, [[nodeA, keyA], [nodeB, keyB]]);

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
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();

            // First host: set version on local replica but add no nodes.
            const hostname1 = 'peer1';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname1, 'version', appVersionStr);
            const L = db.schemaStorageForReplica('x');
            const H1 = db.hostnameSchemaStorage(hostname1);
            await writeGraphScheme(H1);
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
            await writeGraphScheme(H2);
            await writeNode(H2, nodeA, TS1, remoteValue);
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
            await writeGraphScheme(db.schemaStorageForReplica('x'));
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
            await writeGraphScheme(H);
            await writeNode(H, nodeA, TS2, remoteValue);
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
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            // No nodes in H → no changes → no cutover.
            const L = db.schemaStorageForReplica('x');
            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeIdentifierLookup(L, []);
            await writeIdentifierLookup(H, []);
            const switched = await mergeHostIntoReplica(logger, db, hostname);
            expect(switched).toBe(false);
            expect(db.currentReplicaName()).toBe('x');
        } finally {
            if (db) await db.close();
        }
    });

    test('metadata-only host validity proof import switches when endpoints originate from host', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const nodeA = nodeIdentifierFromString('701-abcdefghi');
            const nodeB = nodeIdentifierFromString('702-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"host_stale_A","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"host_stale_B","args":[]}');
            const valueA = { source: 'A', nested: { items: [1, true, null] } };
            const valueB = { source: 'B', nested: { items: ['same'] } };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeA, TS1, { source: 'A target' });
            await writeNode(L, nodeB, TS1, { source: 'B target' });
            await L.freshness.put(nodeB, 'potentially-outdated');
            await writeIdentifierLookup(L, [[nodeA, keyA], [nodeB, keyB]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeA, TS2, valueA);
            await writeNode(H, nodeB, TS2, valueB);
            await H.freshness.put(nodeB, 'potentially-outdated');
            await H.valid.put(nodeA, [nodeB]);
            await writeIdentifierLookup(H, [[nodeA, keyA], [nodeB, keyB]]);

            expect(db.currentReplicaName()).toBe('x');
            const switched = await mergeHostIntoReplica(logger, db, hostname);

            expect(switched).toBe(true);
            expect(db.currentReplicaName()).toBe('y');
            const T = db.getSchemaStorage();
            expect(await T.values.get(nodeA)).toEqual(valueA);
            expect(await T.values.get(nodeB)).toEqual(valueB);
            expect(await T.freshness.get(nodeA)).toBe('up-to-date');
            expect(await T.freshness.get(nodeB)).toBe('potentially-outdated');
            const validA = await T.valid.get(nodeA) ?? [];
            expect(validA.some(dependent => String(dependent) === String(nodeB))).toBe(true);
        } finally {
            if (db) await db.close();
        }
    });

    test('metadata-only host validity proof is not imported from equal values with target provenance', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const nodeA = nodeIdentifierFromString('709-abcdefghi');
            const nodeB = nodeIdentifierFromString('710-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"host_stale_A","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"host_stale_B","args":[]}');
            const valueA = { v: 1 };
            const valueB = { v: 2 };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeA, TS2, valueA);
            await writeNode(L, nodeB, TS2, valueB);
            await L.freshness.put(nodeB, 'potentially-outdated');
            await writeIdentifierLookup(L, [[nodeA, keyA], [nodeB, keyB]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeA, TS1, valueA);
            await writeNode(H, nodeB, TS1, valueB);
            await H.freshness.put(nodeB, 'potentially-outdated');
            await H.valid.put(nodeA, [nodeB]);
            await writeIdentifierLookup(H, [[nodeA, keyA], [nodeB, keyB]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(false);
            expect(db.currentReplicaName()).toBe('x');
            const validA = await db.getSchemaStorage().valid.get(nodeA) ?? [];
            expect(validA.some(dependent => String(dependent) === String(nodeB))).toBe(false);
        } finally {
            if (db) await db.close();
        }
    });

    test('metadata-only merge does not switch when host validity adds nothing', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const nodeA = nodeIdentifierFromString('703-abcdefghi');
            const nodeB = nodeIdentifierFromString('704-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"host_stale_A","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"host_stale_B","args":[]}');
            const valueA = { source: 'A' };
            const valueB = { source: 'B' };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeA, TS1, valueA);
            await writeNode(L, nodeB, TS1, valueB);
            await L.freshness.put(nodeB, 'potentially-outdated');
            await L.valid.put(nodeA, [nodeB]);
            await writeIdentifierLookup(L, [[nodeA, keyA], [nodeB, keyB]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeA, TS1, valueA);
            await writeNode(H, nodeB, TS1, valueB);
            await H.freshness.put(nodeB, 'potentially-outdated');
            await H.valid.put(nodeA, [nodeB]);
            await writeIdentifierLookup(H, [[nodeA, keyA], [nodeB, keyB]]);

            const switched = await mergeHostIntoReplica(logger, db, hostname);
            expect(switched).toBe(false);
            expect(db.currentReplicaName()).toBe('x');
        } finally {
            if (db) await db.close();
        }
    });

    test('host validity proof is not imported when dependent value differs', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const nodeA = nodeIdentifierFromString('705-abcdefghi');
            const nodeB = nodeIdentifierFromString('706-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"host_stale_A","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"host_stale_B","args":[]}');

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeA, TS1, { source: 'A' });
            await writeNode(L, nodeB, TS1, { source: 'B local' });
            await L.freshness.put(nodeB, 'potentially-outdated');
            await writeIdentifierLookup(L, [[nodeA, keyA], [nodeB, keyB]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeA, TS1, { source: 'A' });
            await writeNode(H, nodeB, TS1, { source: 'B host' });
            await H.freshness.put(nodeB, 'potentially-outdated');
            await H.valid.put(nodeA, [nodeB]);
            await writeIdentifierLookup(H, [[nodeA, keyA], [nodeB, keyB]]);

            const switched = await mergeHostIntoReplica(logger, db, hostname);
            expect(switched).toBe(false);
            const validA = await db.getSchemaStorage().valid.get(nodeA) ?? [];
            expect(validA.some(dependent => String(dependent) === String(nodeB))).toBe(false);
        } finally {
            if (db) await db.close();
        }
    });

    test('host validity proof is not imported when dependency value differs', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const nodeA = nodeIdentifierFromString('707-abcdefghi');
            const nodeB = nodeIdentifierFromString('708-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"host_stale_A","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"host_stale_B","args":[]}');

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeA, TS1, { source: 'A local' });
            await writeNode(L, nodeB, TS1, { source: 'B' });
            await L.freshness.put(nodeB, 'potentially-outdated');
            await writeIdentifierLookup(L, [[nodeA, keyA], [nodeB, keyB]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeA, TS1, { source: 'A host' });
            await writeNode(H, nodeB, TS1, { source: 'B' });
            await H.freshness.put(nodeB, 'potentially-outdated');
            await H.valid.put(nodeA, [nodeB]);
            await writeIdentifierLookup(H, [[nodeA, keyA], [nodeB, keyB]]);

            const switched = await mergeHostIntoReplica(logger, db, hostname);
            expect(switched).toBe(false);
            const validA = await db.getSchemaStorage().valid.get(nodeA) ?? [];
            expect(validA.some(dependent => String(dependent) === String(nodeB))).toBe(false);
        } finally {
            if (db) await db.close();
        }
    });

    test('rejects malformed host identifiers lookup during host merge', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeA = NODE_A;
            const remoteValue = { value: { id: 'remote', type: 'test', description: 'remote value' }, isDirty: false };
            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeA, TS2, remoteValue);
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
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            const appVersionStr = db.version;
            await db.setGlobalVersion(appVersionStr);
            await db.setHostnameGlobal(hostname, 'version', appVersionStr);

            const nodeA = NODE_A;
            const remoteValue = { value: { id: 'remote', type: 'test', description: 'remote value' }, isDirty: false };
            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeA, TS2, remoteValue);
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
            await writeGraphScheme(db.schemaStorageForReplica('x'));
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
            await writeNode(L, targetId, TS2, localValue);
            await writeNode(L, dependentId, TS2, undefined);
            await writeIdentifierLookup(L, [[targetId, sharedKey], [dependentId, dependentKey]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, hostId, TS2, { value: { id: 'host', type: 'test', description: 'host' }, isDirty: false });
            await writeNode(H, dependentId, TS2, undefined);
            await writeIdentifierLookup(H, [[hostId, sharedKey], [dependentId, dependentKey]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);
            const T = db.getSchemaStorage();
            expect(await T.values.get(targetId)).toEqual(localValue);
            for (const sublevel of [T.values, T.freshness, T.timestamps]) {
                expect(await sublevel.get(hostId)).toBeUndefined();
            }
            const validShared = await T.valid.get(targetId) ?? [];
            expect(validShared.some(id => String(id) === String(dependentId))).toBe(true);
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
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);
            const targetId = nodeIdentifierFromString('20-abcdefghi');
            const hostId = nodeIdentifierFromString('21-abcdefghi');
            const nodeKey = stringToNodeKeyString('{"head":"newer-local","args":[]}');
            const L = db.schemaStorageForReplica('x');
            await writeNode(L, targetId, TS3, undefined);
            await writeIdentifierLookup(L, [[targetId, nodeKey]]);
            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, hostId, TS1, undefined);
            await writeIdentifierLookup(H, [[hostId, nodeKey]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);
            const T = db.getSchemaStorage();
            expect(await T.global.get(IDENTIFIERS_KEY)).toEqual([[targetId, nodeKey]]);
            expect(await T.values.get(targetId)).toBeDefined();
            expect(await T.values.get(hostId)).toBeUndefined();
        } finally {
            if (db) await db.close();
        }
    });

    test('takes the host identifier for a host-newer semantic node and removes the target identifier', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);
            const targetId = nodeIdentifierFromString('30-abcdefghi');
            const hostId = nodeIdentifierFromString('31-abcdefghi');
            const nodeKey = stringToNodeKeyString('{"head":"newer-host","args":[]}');
            const L = db.schemaStorageForReplica('x');
            await writeNode(L, targetId, TS1, undefined);
            await writeIdentifierLookup(L, [[targetId, nodeKey]]);
            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, hostId, TS3, undefined);
            await writeIdentifierLookup(H, [[hostId, nodeKey]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);
            const T = db.getSchemaStorage();
            expect(await T.global.get(IDENTIFIERS_KEY)).toEqual([[hostId, nodeKey]]);
            expect(await T.freshness.get(hostId)).toBeDefined();
            for (const sublevel of [T.values, T.freshness, T.timestamps]) {
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
            await writeGraphScheme(db.schemaStorageForReplica('x'));
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
            await writeNode(L, bId, TS2, undefined);
            await writeNode(L, targetCId, TS3, undefined);
            await writeIdentifierLookup(L, [[bId, keyB], [targetCId, keyC]]);
            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, bId, TS2, undefined);
            await writeNode(H, hostCId, TS1, undefined);
            await writeNode(H, hostAId, TS2, undefined);
            await writeIdentifierLookup(H, [[bId, keyB], [hostCId, keyC], [hostAId, keyA]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);
            const T = db.getSchemaStorage();
            expect(await T.freshness.get(hostAId)).toBe('potentially-outdated');
            expect(await T.valid.get(targetCId)).toBeUndefined();
            expect(await T.values.get(hostCId)).toBeUndefined();
        } finally {
            if (db) await db.close();
        }
    });

    test('pull recomputes a directly relowered node when validity flags are rebuilt', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const targetCId = nodeIdentifierFromString('47-abcdefghi');
            const hostCId = nodeIdentifierFromString('48-abcdefghi');
            const hostAId = nodeIdentifierFromString('49-abcdefghi');
            const keyC = stringToNodeKeyString('{"head":"c_counter_collision","args":[]}');
            const keyA = stringToNodeKeyString('{"head":"a_counter_collision","args":[]}');
            const targetCValue = { source: 'target C' };
            const staleAValue = { source: 'A computed from host C' };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, targetCId, TS1, targetCValue);
            await writeIdentifierLookup(L, [[targetCId, keyC]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, hostCId, TS1, { source: 'host C' });
            await writeNode(H, hostAId, TS1, staleAValue);
            await writeIdentifierLookup(H, [[hostCId, keyC], [hostAId, keyA]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);

            // The directly relowered node should be stale because its structural
            // dependency changed from hostCId to targetCId.
            const T = db.getSchemaStorage();
            expect(await T.freshness.get(hostAId)).toBe('potentially-outdated');

            // Write exact graph_scheme matching the nodeDefs below (nodes are sorted alphabetically by head)
            await T.global.put(GRAPH_SCHEME_KEY, JSON.stringify({
                format: 1,
                nodes: [
                    { head: "a_counter_collision", arity: 0, inputTemplates: [{ head: "c_counter_collision", args: [] }] },
                    { head: "c_counter_collision", arity: 0, inputTemplates: [] },
                ],
            }));

            const computeA = jest.fn(async ([input]) => ({ source: `recomputed from ${input.source}` }));
            const graph = await createIncrementalGraph(capabilities, db, [
                {
                    output: 'c_counter_collision',
                    inputs: [],
                    computor: async () => targetCValue,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: 'a_counter_collision',
                    inputs: ['c_counter_collision'],
                    computor: computeA,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            await expect(graph.pull('a_counter_collision')).resolves.toEqual({ source: 'recomputed from target C' });
            expect(computeA).toHaveBeenCalledTimes(1);
        } finally {
            if (db) await db.close();
        }
    });

    test('relowered invalidation propagates transitively and pull recomputes dependents', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const targetCId = nodeIdentifierFromString('53-abcdefghi');
            const hostCId = nodeIdentifierFromString('54-abcdefghi');
            const hostAId = nodeIdentifierFromString('55-abcdefghi');
            const hostDId = nodeIdentifierFromString('56-abcdefghi');
            const keyC = stringToNodeKeyString('{"head":"c_transitive_relower","args":[]}');
            const keyA = stringToNodeKeyString('{"head":"a_transitive_relower","args":[]}');
            const keyD = stringToNodeKeyString('{"head":"d_transitive_relower","args":[]}');
            const targetCValue = { source: 'target C' };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, targetCId, TS1, targetCValue);
            await writeIdentifierLookup(L, [[targetCId, keyC]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, hostCId, TS1, { source: 'host C' });
            await writeNode(H, hostAId, TS1, { source: 'stale A' });
            await writeNode(H, hostDId, TS1, { source: 'stale D' });
            await writeIdentifierLookup(H, [
                [hostCId, keyC],
                [hostAId, keyA],
                [hostDId, keyD],
            ]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);

            // Directly relowered node and its transitive dependent are both stale.
            const T = db.getSchemaStorage();
            expect(await T.freshness.get(hostAId)).toBe('potentially-outdated');
            expect(await T.freshness.get(hostDId)).toBe('potentially-outdated');

            // Write exact graph_scheme matching the nodeDefs below (nodes are sorted alphabetically by head)
            await T.global.put(GRAPH_SCHEME_KEY, JSON.stringify({
                format: 1,
                nodes: [
                    { head: "a_transitive_relower", arity: 0, inputTemplates: [{ head: "c_transitive_relower", args: [] }] },
                    { head: "c_transitive_relower", arity: 0, inputTemplates: [] },
                    { head: "d_transitive_relower", arity: 0, inputTemplates: [{ head: "a_transitive_relower", args: [] }] },
                ],
            }));

            const computeA = jest.fn(async ([input]) => ({ source: `A from ${input.source}` }));
            const computeD = jest.fn(async ([input]) => ({ source: `D from ${input.source}` }));
            const graph = await createIncrementalGraph(capabilities, db, [
                {
                    output: 'c_transitive_relower',
                    inputs: [],
                    computor: async () => targetCValue,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: 'a_transitive_relower',
                    inputs: ['c_transitive_relower'],
                    computor: computeA,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: 'd_transitive_relower',
                    inputs: ['a_transitive_relower'],
                    computor: computeD,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            await expect(graph.pull('d_transitive_relower')).resolves.toEqual({
                source: 'D from A from target C',
            });
            expect(computeA).toHaveBeenCalledTimes(1);
            expect(computeD).toHaveBeenCalledTimes(1);
        } finally {
            if (db) await db.close();
        }
    });

    test('invalidates a target-only node whose semantic input is taken from host', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
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
            await writeNode(L, targetCId, TS1, undefined);
            await writeNode(L, targetDId, TS2, targetDValue);
            await writeIdentifierLookup(L, [
                [targetCId, keyC],
                [targetDId, keyD],
            ]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, hostCId, TS3, undefined);
            await writeIdentifierLookup(H, [[hostCId, keyC]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);
            const T = db.getSchemaStorage();
            expect(await T.global.get(IDENTIFIERS_KEY)).toEqual([
                [hostCId, keyC],
                [targetDId, keyD],
            ]);
            // D's dependency C was relowered from targetCId to hostCId, making
            // D directly relowered. Its value is deleted and freshness becomes
            // potentially-outdated.
            expect(await T.values.get(targetDId)).toBeUndefined();
            expect(await T.freshness.get(targetDId)).toBe('potentially-outdated');
            expect(await T.valid.get(hostCId)).toBeUndefined();
            expect(await T.values.get(targetCId)).toBeUndefined();
        } finally {
            if (db) await db.close();
        }
    });

    test('unrelated merge change preserves clean nodes and their validity', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const nodeAId = nodeIdentifierFromString('60-abcdefghi');
            const nodeBId = nodeIdentifierFromString('61-abcdefghi');
            const nodeXId = nodeIdentifierFromString('62-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"A_unrelated","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"B_unrelated","args":[]}');
            const keyX = stringToNodeKeyString('{"head":"X_unrelated","args":[]}');
            const valueA = { source: 'A' };
            const valueB = { source: 'B' };
            const remoteXValue = { source: 'remote X' };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeAId, TS1, valueA);
            await writeNode(L, nodeBId, TS1, valueB);
            await L.valid.put(nodeAId, [nodeBId]);
            await writeIdentifierLookup(L, [[nodeAId, keyA], [nodeBId, keyB]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeXId, TS2, remoteXValue);
            await writeIdentifierLookup(H, [[nodeXId, keyX]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);

            const T = db.getSchemaStorage();
            expect(await T.freshness.get(nodeBId)).toBe('up-to-date');
            expect(await T.valid.get(nodeAId)).toEqual([nodeBId]);

            // Write exact graph_scheme matching the nodeDefs below
            await T.global.put(GRAPH_SCHEME_KEY, JSON.stringify({
                format: 1,
                nodes: [
                    { head: "A_unrelated", arity: 0, inputTemplates: [] },
                    { head: "B_unrelated", arity: 0, inputTemplates: [{ head: "A_unrelated", args: [] }] },
                    { head: "X_unrelated", arity: 0, inputTemplates: [] },
                ],
            }));

            const computeB = jest.fn(async () => ({ source: 'should not be called' }));
            const graph = await createIncrementalGraph(capabilities, db, [
                { output: 'A_unrelated', inputs: [], computor: async () => valueA, isDeterministic: true, hasSideEffects: false },
                { output: 'B_unrelated', inputs: ['A_unrelated'], computor: computeB, isDeterministic: true, hasSideEffects: false },
                { output: 'X_unrelated', inputs: [], computor: async () => remoteXValue, isDeterministic: true, hasSideEffects: false },
            ]);

            const pulled = await graph.pull('B_unrelated');
            expect(pulled).toEqual(valueB);
            expect(computeB).toHaveBeenCalledTimes(0);
        } finally {
            if (db) await db.close();
        }
    });

    test('precise invalidation coexists with unrelated clean preservation', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const nodeAId = nodeIdentifierFromString('63-abcdefghi');
            const nodeBId = nodeIdentifierFromString('64-abcdefghi');
            const nodeCId = nodeIdentifierFromString('65-abcdefghi');
            const nodeDId = nodeIdentifierFromString('66-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"A_precise","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"B_precise","args":[]}');
            const keyC = stringToNodeKeyString('{"head":"C_precise","args":[]}');
            const keyD = stringToNodeKeyString('{"head":"D_precise","args":[]}');
            const valueC = { source: 'C' };
            const valueD = { source: 'D' };

            const L = db.schemaStorageForReplica('x');
            // A -> B side: A is taken from H (H has newer timestamp)
            await writeNode(L, nodeAId, TS1, { source: 'A local' });
            await writeNode(L, nodeBId, TS2, { source: 'B local' });
            // C -> D side: both are kept locally
            await writeNode(L, nodeCId, TS3, valueC);
            await writeNode(L, nodeDId, TS3, valueD);
            await L.valid.put(nodeCId, [nodeDId]);
            await writeIdentifierLookup(L, [
                [nodeAId, keyA], [nodeBId, keyB],
                [nodeCId, keyC], [nodeDId, keyD],
            ]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeAId, TS2, { source: 'A remote' });
            await writeNode(H, nodeBId, TS1, { source: 'B remote' });
            await writeNode(H, nodeCId, TS1, { source: 'C remote' });
            await writeNode(H, nodeDId, TS1, { source: 'D remote' });
            await writeIdentifierLookup(H, [
                [nodeAId, keyA], [nodeBId, keyB],
                [nodeCId, keyC], [nodeDId, keyD],
            ]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);

            const T = db.getSchemaStorage();

            // B must be invalidated (take-tainted via A + keep-tainted via self)
            expect(await T.freshness.get(nodeBId)).toBe('potentially-outdated');

            // D must remain up-to-date
            expect(await T.freshness.get(nodeDId)).toBe('up-to-date');

            // valid[C] must contain D
            expect(await T.valid.get(nodeCId)).toEqual([nodeDId]);

            // Write exact graph_scheme matching the nodeDefs below
            await T.global.put(GRAPH_SCHEME_KEY, JSON.stringify({
                format: 1,
                nodes: [
                    { head: "A_precise", arity: 0, inputTemplates: [] },
                    { head: "B_precise", arity: 0, inputTemplates: [{ head: "A_precise", args: [] }] },
                    { head: "C_precise", arity: 0, inputTemplates: [] },
                    { head: "D_precise", arity: 0, inputTemplates: [{ head: "C_precise", args: [] }] },
                ],
            }));

            const computeD = jest.fn(async () => ({ source: 'should not be called' }));
            const graph = await createIncrementalGraph(capabilities, db, [
                { output: 'A_precise', inputs: [], computor: async () => ({ source: 'A' }), isDeterministic: true, hasSideEffects: false },
                { output: 'B_precise', inputs: ['A_precise'], computor: async () => ({ source: 'B' }), isDeterministic: true, hasSideEffects: false },
                { output: 'C_precise', inputs: [], computor: async () => valueC, isDeterministic: true, hasSideEffects: false },
                { output: 'D_precise', inputs: ['C_precise'], computor: computeD, isDeterministic: true, hasSideEffects: false },
            ]);

            const pulled = await graph.pull('D_precise');
            expect(pulled).toEqual(valueD);
            expect(computeD).toHaveBeenCalledTimes(0);
        } finally {
            if (db) await db.close();
        }
    });

    test('rebuilt validity excludes stale nodes', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const nodeAId = nodeIdentifierFromString('67-abcdefghi');
            const nodeBId = nodeIdentifierFromString('68-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"A_stale","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"B_stale","args":[]}');

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeAId, TS1, { source: 'A' });
            await writeNode(L, nodeBId, TS2, { source: 'B' });
            await writeIdentifierLookup(L, [[nodeAId, keyA], [nodeBId, keyB]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            // H has newer A, older B → A is taken, B is kept but tainted → invalidated
            await writeNode(H, nodeAId, TS2, { source: 'A remote' });
            await writeNode(H, nodeBId, TS1, { source: 'B remote' });
            await writeIdentifierLookup(H, [[nodeAId, keyA], [nodeBId, keyB]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);

            const T = db.getSchemaStorage();

            // B is potentally-outdated after invalidation
            expect(await T.freshness.get(nodeBId)).toBe('potentially-outdated');

            // B's value still references A (structural data preserved)
            expect(await T.values.get(nodeBId)).toEqual({ source: 'B' });

            // valid[A] must not contain the stale B
            const validA = await T.valid.get(nodeAId) ?? [];
            const bIdStr = String(nodeBId);
            expect(validA.some(d => String(d) === bIdStr)).toBe(false);
        } finally {
            if (db) await db.close();
        }
    });

    test('final validation rejects up-to-date node lacking incoming validity flag', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);

            const nodeA = NODE_A;
            const nodeB = NODE_B;
            const keyA = stringToNodeKeyString('{"head":"A_missing_valid","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"B_missing_valid","args":[]}');
            const T = db.schemaStorageForReplica('x');
            await writeGraphScheme(T);

            await T.values.put(nodeA, { v: 1 });
            await T.values.put(nodeB, { v: 2 });
            await T.freshness.put(nodeA, 'up-to-date');
            await T.freshness.put(nodeB, 'up-to-date');
            // valid[A] is missing B — up-to-date B lacks its required validity flag

            const lookup = makeIdentifierLookup([
                [nodeA, keyA],
                [nodeB, keyB],
            ]);

            await expect(
                assertValidFinalMergeState(T, lookup)
            ).rejects.toThrow(FinalMergeStateError);
        } finally {
            if (db) await db.close();
        }
    });

    describe('assertValidFinalMergeState', () => {
        test('rejects materialized node when graph_scheme is missing', async () => {
            const capabilities = getTestCapabilities();
            let db;
            try {
                db = await getRootDatabase(capabilities);

                const nodeA = NODE_A;
                const T = db.schemaStorageForReplica('x');
                await T.values.put(nodeA, { v: 1 });
                await T.freshness.put(nodeA, 'up-to-date');

                const lookup = makeIdentifierLookup([[nodeA, stringToNodeKeyString('{"head":"test","args":[]}')]]);

                await expect(
                    assertValidFinalMergeState(T, lookup)
                ).rejects.toThrow(/graph_scheme/);
            } finally {
                if (db) await db.close();
            }
        });

        test('rejects valid entry referencing unknown identifier', async () => {
            const capabilities = getTestCapabilities();
            let db;
            try {
                db = await getRootDatabase(capabilities);

                const nodeA = NODE_A;
                const knownNodeIds = [nodeIdentifierFromString('99-abcdefghi')]; // unknown identifier
                const T = db.schemaStorageForReplica('x');
                await writeGraphScheme(T);
                // Materialize A
                await T.values.put(nodeA, { v: 1 });
                await T.freshness.put(nodeA, 'up-to-date');
                // Write valid for A referencing an unknown identifier
                await T.valid.put(nodeA, knownNodeIds);

                const lookup = makeIdentifierLookup([[nodeA, stringToNodeKeyString('{"head":"test","args":[]}')]]);

                await expect(
                    assertValidFinalMergeState(T, lookup)
                ).rejects.toThrow(FinalMergeStateError);
            } finally {
                if (db) await db.close();
            }
        });

        test('rejects valid entry for discarded identifier', async () => {
            const capabilities = getTestCapabilities();
            let db;
            try {
                db = await getRootDatabase(capabilities);

                const nodeA = NODE_A;
                const discardedId = nodeIdentifierFromString('99-abcdefghi');
                const T = db.schemaStorageForReplica('x');
                await writeGraphScheme(T);
                // Materialize A (known identifier)
                await T.values.put(nodeA, { v: 1 });
                await T.freshness.put(nodeA, 'up-to-date');
                // Write valid entry for a discarded identifier that is NOT in the lookup
                await T.valid.put(discardedId, [nodeA]);

                const lookup = makeIdentifierLookup([[nodeA, stringToNodeKeyString('{"head":"test","args":[]}')]]);

                await expect(
                    assertValidFinalMergeState(T, lookup)
                ).rejects.toThrow(FinalMergeStateError);
            } finally {
                if (db) await db.close();
            }
        });

        test('rejects valid value entry referencing unknown identifier', async () => {
            const capabilities = getTestCapabilities();
            let db;
            try {
                db = await getRootDatabase(capabilities);

                const nodeA = NODE_A;
                const nodeB = NODE_B;
                const unknownId = nodeIdentifierFromString('99-abcdefghi');
                const keyA = stringToNodeKeyString('{"head":"A","args":[]}');
                const keyB = stringToNodeKeyString('{"head":"B","args":[]}');
                const T = db.schemaStorageForReplica('x');
                await writeGraphScheme(T);
                // Materialize A and B
                await T.values.put(nodeA, { v: 1 });
                await T.values.put(nodeB, { v: 2 });
                await T.freshness.put(nodeA, 'up-to-date');
                await T.freshness.put(nodeB, 'up-to-date');
                // Write valid[A] containing an unknown identifier
                await T.valid.put(nodeA, [unknownId]);

                const lookup = makeIdentifierLookup([
                    [nodeA, keyA],
                    [nodeB, keyB],
                ]);

                await expect(
                    assertValidFinalMergeState(T, lookup)
                ).rejects.toThrow(FinalMergeStateError);
            } finally {
                if (db) await db.close();
            }
        });

        test('rejects valid entry when dependency is in lookup but not materialized', async () => {
            const capabilities = getTestCapabilities();
            let db;
            try {
                db = await getRootDatabase(capabilities);

                const parentId = nodeIdentifierFromString('91-abcdefghi');
                const childId = nodeIdentifierFromString('92-abcdefghi');
                const parentKey = stringToNodeKeyString('{"head":"parent","args":[]}');
                const childKey = stringToNodeKeyString('{"head":"child","args":[]}');
                const T = db.schemaStorageForReplica('x');
                await writeGraphScheme(T);
                // child is materialized, parent is in lookup but NOT materialized
                await T.values.put(childId, { v: 2 });
                await T.freshness.put(childId, 'up-to-date');
                // valid[parentId] = [childId]
                await T.valid.put(parentId, [childId]);

                const lookup = makeIdentifierLookup([
                    [parentId, parentKey],
                    [childId, childKey],
                ]);

                await expect(
                    assertValidFinalMergeState(T, lookup)
                ).rejects.toThrow(FinalMergeStateError);
            } finally {
                if (db) await db.close();
            }
        });

        test('rejects up-to-date node depending on non-materialized input', async () => {
            const capabilities = getTestCapabilities();
            let db;
            try {
                db = await getRootDatabase(capabilities);

                const parentId = nodeIdentifierFromString('93-abcdefghi');
                const childId = nodeIdentifierFromString('94-abcdefghi');
                const parentKey = stringToNodeKeyString('{"head":"parent","args":[]}');
                const childKey = stringToNodeKeyString('{"head":"child","args":[]}');
                const T = db.schemaStorageForReplica('x');
                await writeGraphScheme(T);
                // child is materialized and up-to-date, depends on parent per scheme
                await T.values.put(childId, { v: 2 });
                await T.freshness.put(childId, 'up-to-date');
                // parent is in lookup but NOT materialized (no values entry)

                const lookup = makeIdentifierLookup([
                    [parentId, parentKey],
                    [childId, childKey],
                ]);

                await expect(
                    assertValidFinalMergeState(T, lookup)
                ).rejects.toThrow(FinalMergeStateError);
            } finally {
                if (db) await db.close();
            }
        });
    });

    test('merge preserves valid for stale nodes when unrelated change occurs', async () => {
        // A → B
        // B is potentially-outdated, valid[A] contains B
        // merge introduces unrelated node X
        // after merge valid[A] still contains B
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const nodeAId = nodeIdentifierFromString('69-abcdefghi');
            const nodeBId = nodeIdentifierFromString('70-abcdefghi');
            const nodeXId = nodeIdentifierFromString('71-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"A_stale_preserve","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"B_stale_preserve","args":[]}');
            const keyX = stringToNodeKeyString('{"head":"X_stale_preserve","args":[]}');

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeAId, TS1, { source: 'A' });
            await writeNode(L, nodeBId, TS1, { source: 'B' });
            await L.freshness.put(nodeBId, 'potentially-outdated');
            await L.valid.put(nodeAId, [nodeBId]);
            await writeIdentifierLookup(L, [[nodeAId, keyA], [nodeBId, keyB]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeXId, TS2, { source: 'remote X' });
            await writeIdentifierLookup(H, [[nodeXId, keyX]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);

            const T = db.getSchemaStorage();
            expect(await T.freshness.get(nodeBId)).toBe('potentially-outdated');
            const validA = await T.valid.get(nodeAId) ?? [];
            const bIdStr = String(nodeBId);
            expect(validA.some(d => String(d) === bIdStr)).toBe(true);
        } finally {
            if (db) await db.close();
        }
    });

    test('merge removes valid for stale nodes when dependency value changes', async () => {
        // A → B
        // B is potentially-outdated, valid[A] contains B
        // merge changes A's value (A is taken from host with newer timestamp)
        // after merge valid[A] no longer contains B
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const nodeAId = nodeIdentifierFromString('72-abcdefghi');
            const nodeBId = nodeIdentifierFromString('73-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"A_value_change","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"B_value_change","args":[]}');

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeAId, TS1, { source: 'A old' });
            await writeNode(L, nodeBId, TS2, { source: 'B' });
            await L.freshness.put(nodeBId, 'potentially-outdated');
            await L.valid.put(nodeAId, [nodeBId]);
            await writeIdentifierLookup(L, [[nodeAId, keyA], [nodeBId, keyB]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeAId, TS2, { source: 'A new remote' });
            await writeNode(H, nodeBId, TS1, { source: 'B old' });
            await writeIdentifierLookup(H, [[nodeAId, keyA], [nodeBId, keyB]]);

            expect(await mergeHostIntoReplica(logger, db, hostname)).toBe(true);

            const T = db.getSchemaStorage();
            // A is taken from host, B is now tainted → invalidate
            const validA = await T.valid.get(nodeAId) ?? [];
            const bIdStr = String(nodeBId);
            expect(validA.some(d => String(d) === bIdStr)).toBe(false);
        } finally {
            if (db) await db.close();
        }
    });

    test('merge ensures required valid flag for up-to-date node even if missing before', async () => {
        // A → B
        // B is up-to-date
        // valid[A] is missing B before merge
        // merge result keeps B up-to-date (H-only C forces changes)
        // after merge valid[A] contains B
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const nodeAId = nodeIdentifierFromString('74-abcdefghi');
            const nodeBId = nodeIdentifierFromString('75-abcdefghi');
            const nodeCId = nodeIdentifierFromString('76-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"A_required_flag","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"B_required_flag","args":[]}');
            const keyC = stringToNodeKeyString('{"head":"C_extra","args":[]}');

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeAId, TS1, { source: 'A' });
            await writeNode(L, nodeBId, TS1, { source: 'B' });
            // valid[A] intentionally missing B
            await writeIdentifierLookup(L, [[nodeAId, keyA], [nodeBId, keyB]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeAId, TS1, { source: 'A remote' });
            await writeNode(H, nodeBId, TS1, { source: 'B remote' });
            await writeNode(H, nodeCId, TS2, { source: 'C remote' });
            await writeIdentifierLookup(H, [
                [nodeAId, keyA], [nodeBId, keyB], [nodeCId, keyC]
            ]);

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const T = db.getSchemaStorage();
            expect(await T.freshness.get(nodeBId)).toBe('up-to-date');
            const validA = await T.valid.get(nodeAId) ?? [];
            const bIdStr = String(nodeBId);
            expect(validA.some(d => String(d) === bIdStr)).toBe(true);
        } finally {
            if (db) await db.close();
        }
    });

    test('1. host-side stale validity proof is preserved', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const nodeA = nodeIdentifierFromString('101-abcdefghi');
            const nodeB = nodeIdentifierFromString('102-abcdefghi');
            const nodeC = nodeIdentifierFromString('103-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"host_stale_A","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"host_stale_B","args":[]}');
            const keyC = stringToNodeKeyString('{"head":"host_stale_C","args":[]}');

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeA, TS1, { source: 'A' });
            await writeNode(L, nodeB, TS1, { source: 'B' });
            await writeNode(L, nodeC, TS1, { source: 'C' });
            await writeIdentifierLookup(L, [[nodeA, keyA], [nodeB, keyB], [nodeC, keyC]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, nodeA, TS2, { source: 'A host' });
            await writeNode(H, nodeB, TS2, { source: 'B host' });
            await writeNode(H, nodeC, TS2, { source: 'C host' });
            await H.freshness.put(nodeB, 'potentially-outdated');
            await H.freshness.put(nodeC, 'potentially-outdated');
            await H.valid.put(nodeA, [nodeB]);
            await H.valid.put(nodeB, [nodeC]);
            await writeIdentifierLookup(H, [[nodeA, keyA], [nodeB, keyB], [nodeC, keyC]]);

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const T = db.getSchemaStorage();
            const validA = await T.valid.get(nodeA) ?? [];
            const validB = await T.valid.get(nodeB) ?? [];
            const bIdStr = String(nodeB);
            const cIdStr = String(nodeC);
            expect(validA.some(d => String(d) === bIdStr)).toBe(true);
            expect(validB.some(d => String(d) === cIdStr)).toBe(true);
            expect(await T.freshness.get(nodeB)).toBe('potentially-outdated');
            expect(await T.freshness.get(nodeC)).toBe('potentially-outdated');
        } finally {
            if (db) await db.close();
        }
    });

    test('2. target-side stale validity proof is preserved even when merge decision is invalidate, if value preserved', async () => {
        const { rebuildMergedValidity } = require('../src/generators/incremental_graph/database/sync_merge_validity');
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);

            const nodeA = nodeIdentifierFromString('104-abcdefghi');
            const nodeB = nodeIdentifierFromString('105-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"host_stale_A","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"host_stale_B","args":[]}');

            const storage = db.schemaStorageForReplica('x');
            await writeGraphScheme(storage);

            await storage.values.put(nodeA, { source: 'A' });
            await storage.values.put(nodeB, { source: 'B' });
            await storage.freshness.put(nodeA, 'up-to-date');
            await storage.freshness.put(nodeB, 'potentially-outdated');
            await storage.valid.put(nodeA, [nodeB]);

            const lookup = makeIdentifierLookup([[nodeA, keyA], [nodeB, keyB]]);
            await writeIdentifierLookup(storage, [[nodeA, keyA], [nodeB, keyB]]);

            const valueOriginByKey = new Map();
            valueOriginByKey.set(keyA, { kind: 'source', side: 'target', sourceId: nodeA });
            valueOriginByKey.set(keyB, { kind: 'source', side: 'target', sourceId: nodeB });

            const finalIdentifierForKey = new Map();
            finalIdentifierForKey.set(keyA, nodeA);
            finalIdentifierForKey.set(keyB, nodeB);

            const mergedInputsMap = new Map();
            mergedInputsMap.set(nodeB, [nodeA]);

            const targetStorage = db.schemaStorageForReplica('y');
            await writeGraphScheme(targetStorage);
            await targetStorage.values.put(nodeA, { source: 'A' });
            await targetStorage.values.put(nodeB, { source: 'B' });
            await targetStorage.freshness.put(nodeA, 'up-to-date');
            await targetStorage.freshness.put(nodeB, 'potentially-outdated');

            const hostStorage = db.hostnameSchemaStorage('host');
            await writeGraphScheme(hostStorage);
            await hostStorage.values.put(nodeA, { source: 'A host' });
            await hostStorage.values.put(nodeB, { source: 'B host' });
            const hostLookup = makeIdentifierLookup([[nodeA, keyA], [nodeB, keyB]]);
            await writeIdentifierLookup(hostStorage, [[nodeA, keyA], [nodeB, keyB]]);

            await rebuildMergedValidity({
                targetStorage,
                targetSourceStorage: storage,
                hostSourceStorage: hostStorage,
                targetLookup: lookup,
                hostLookup,
                finalIdentifierForKey,
                mergedInputsMap,
                valueOriginByKey,
            });

            const validA = await targetStorage.valid.get(nodeA) ?? [];
            const bIdStr = String(nodeB);
            expect(validA.some(d => String(d) === bIdStr)).toBe(true);
        } finally {
            if (db) await db.close();
        }
    });



    test('value origins are none when final or source values are absent', async () => {
        const { buildValueOriginByKey, rebuildMergedValidity } = require('../src/generators/incremental_graph/database/sync_merge_validity');
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);

            const sourceA = nodeIdentifierFromString('122-abcdefghi');
            const sourceB = nodeIdentifierFromString('123-abcdefghi');
            const finalA = nodeIdentifierFromString('124-abcdefghi');
            const finalB = nodeIdentifierFromString('125-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"origin_absent_A","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"origin_absent_B","args":[]}');

            const targetSourceStorage = db.schemaStorageForReplica('x');
            await writeGraphScheme(targetSourceStorage);
            await targetSourceStorage.values.put(sourceA, { v: 'A' });
            await targetSourceStorage.valid.put(sourceA, [sourceB]);
            const targetLookup = makeIdentifierLookup([[sourceA, keyA], [sourceB, keyB]]);

            const hostSourceStorage = db.hostnameSchemaStorage('origin-host');
            await writeGraphScheme(hostSourceStorage);
            const hostLookup = makeIdentifierLookup([]);

            const targetStorage = db.schemaStorageForReplica('y');
            await writeGraphScheme(targetStorage);
            await targetStorage.values.put(finalA, { v: 'A' });
            await targetStorage.freshness.put(finalA, 'potentially-outdated');
            await targetStorage.freshness.put(finalB, 'potentially-outdated');

            const initialDecisions = new Map([[keyA, 'keep'], [keyB, 'keep']]);
            const decisions = new Map([[keyA, 'keep'], [keyB, 'keep']]);
            const finalIdentifierForKey = new Map([[keyA, finalA], [keyB, finalB]]);

            const valueOriginByKey = await buildValueOriginByKey(
                initialDecisions,
                decisions,
                targetLookup,
                hostLookup,
                new Set(),
                targetStorage,
                targetSourceStorage,
                hostSourceStorage,
                finalIdentifierForKey
            );

            expect(valueOriginByKey.get(keyA)).toEqual({ kind: 'source', side: 'target', sourceId: sourceA });
            expect(valueOriginByKey.get(keyB)).toEqual({ kind: 'none' });

            await rebuildMergedValidity({
                targetStorage,
                targetSourceStorage,
                hostSourceStorage,
                targetLookup,
                hostLookup,
                finalIdentifierForKey,
                mergedInputsMap: new Map([[finalB, [finalA]]]),
                valueOriginByKey,
            });

            const validA = await targetStorage.valid.get(finalA) ?? [];
            expect(validA.some(dependent => String(dependent) === String(finalB))).toBe(false);
        } finally {
            if (db) await db.close();
        }
    });

    test('3. cross-side mixed proofs are not preserved', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const targetA = nodeIdentifierFromString('106-abcdefghi');
            const hostB = nodeIdentifierFromString('109-abcdefghi');
            const oldHostA = nodeIdentifierFromString('108-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"cross_A","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"cross_B","args":[]}');

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, targetA, TS2, { source: 'A target' });
            await writeIdentifierLookup(L, [[targetA, keyA]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, oldHostA, TS1, { source: 'A host' });
            await writeNode(H, hostB, TS3, { source: 'B host' });
            await H.freshness.put(hostB, 'potentially-outdated');
            await H.valid.put(oldHostA, [hostB]);
            await writeIdentifierLookup(H, [[oldHostA, keyA], [hostB, keyB]]);

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const T = db.getSchemaStorage();
            // A is kept (target-newer, TS2 > TS1): finalA = targetA
            // B is taken (host-newer, TS3 > target has no B): finalB = hostB
            // oldHostA is deleted (A was kept from target)
            expect(await T.values.get(oldHostA)).toBeUndefined();
            expect(await T.valid.get(oldHostA) ?? []).toEqual([]);
            // Since hostB is potentially-outdated, no mandatory rebuild adds it.
            // The host-side proof valid[oldHostA] = [hostB] doesn't transport because
            // oldHostA's origin (host) differs from targetA (target).
            const validFinalA = await T.valid.get(targetA) ?? [];
            const bIdStr = String(hostB);
            expect(validFinalA.some(d => String(d) === bIdStr)).toBe(false);
        } finally {
            if (db) await db.close();
        }
    });

    test('cross-side equal-value proof is not imported when the dependent is directly relowered', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            // Target has A_target (TS3), no B.
            // Host has A_host (TS1, same value), B_host (TS2 with dep on A).
            const targetA = nodeIdentifierFromString('116-abcdefghi');
            const hostA = nodeIdentifierFromString('117-abcdefghi');
            const hostB = nodeIdentifierFromString('118-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"cross_A","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"cross_B","args":[]}');
            const equalValue = { source: 'shared', version: 1 };

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, targetA, TS3, equalValue);
            await writeIdentifierLookup(L, [[targetA, keyA]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, hostA, TS1, equalValue);
            await writeNode(H, hostB, TS2, { source: 'B host' });
            await H.freshness.put(hostB, 'potentially-outdated');
            await H.valid.put(hostA, [hostB]);
            await writeIdentifierLookup(H, [[hostA, keyA], [hostB, keyB]]);

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const T = db.getSchemaStorage();
            // A is kept (target-newer, TS3 > TS1)
            expect(await T.values.get(targetA)).toEqual(equalValue);
            // hostA is deleted (keep chose targetA)
            expect(await T.values.get(hostA)).toBeUndefined();
            // B was taken but directly relowered because its source input uses
            // hostA and its final input uses targetA. Direct relowering deletes
            // B's value, so B cannot carry host provenance into the final graph.
            const validA = await T.valid.get(targetA) ?? [];
            const bIdStr = String(hostB);
            expect(validA.some(d => String(d) === bIdStr)).toBe(false);
        } finally {
            if (db) await db.close();
        }
    });

    test('cross-side equal-value proof is not imported when final dependent remains materialized', async () => {
        const { rebuildMergedValidity } = require('../src/generators/incremental_graph/database/sync_merge_validity');
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);

            const targetA = nodeIdentifierFromString('130-abcdefghi');
            const hostA = nodeIdentifierFromString('131-abcdefghi');
            const hostB = nodeIdentifierFromString('132-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"cross_equal_A","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"cross_equal_B","args":[]}');
            const equalValue = { v: 1 };

            const targetStorage = db.schemaStorageForReplica('y');
            await writeGraphScheme(targetStorage);
            await targetStorage.values.put(targetA, equalValue);
            await targetStorage.values.put(hostB, { v: 'host B' });
            await targetStorage.freshness.put(targetA, 'up-to-date');
            await targetStorage.freshness.put(hostB, 'potentially-outdated');

            const targetSourceStorage = db.schemaStorageForReplica('x');
            await writeGraphScheme(targetSourceStorage);
            await targetSourceStorage.values.put(targetA, equalValue);
            const targetLookup = makeIdentifierLookup([[targetA, keyA]]);

            const hostStorage = db.hostnameSchemaStorage('cross-equal-host');
            await writeGraphScheme(hostStorage);
            await hostStorage.values.put(hostA, equalValue);
            await hostStorage.values.put(hostB, { v: 'host B' });
            await hostStorage.freshness.put(hostB, 'potentially-outdated');
            await hostStorage.valid.put(hostA, [hostB]);
            const hostLookup = makeIdentifierLookup([[hostA, keyA], [hostB, keyB]]);

            await rebuildMergedValidity({
                targetStorage,
                targetSourceStorage,
                hostSourceStorage: hostStorage,
                targetLookup,
                hostLookup,
                finalIdentifierForKey: new Map([[keyA, targetA], [keyB, hostB]]),
                mergedInputsMap: new Map([[hostB, [targetA]]]),
                valueOriginByKey: new Map([
                    [keyA, { kind: 'source', side: 'target', sourceId: targetA }],
                    [keyB, { kind: 'source', side: 'host', sourceId: hostB }],
                ]),
            });

            const validA = await targetStorage.valid.get(targetA) ?? [];
            expect(validA.some(dependent => String(dependent) === String(hostB))).toBe(false);
        } finally {
            if (db) await db.close();
        }
    });

    test('4. identifier lowering transports valid proofs to final identifiers', async () => {
        const { rebuildMergedValidity } = require('../src/generators/incremental_graph/database/sync_merge_validity');
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);

            const hostA = nodeIdentifierFromString('112-abcdefghi');
            const hostB = nodeIdentifierFromString('113-abcdefghi');
            const finalA = nodeIdentifierFromString('114-abcdefghi');
            const finalB = nodeIdentifierFromString('115-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"ident_A","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"ident_B","args":[]}');

            const targetStorage = db.schemaStorageForReplica('y');
            await writeGraphScheme(targetStorage);
            await targetStorage.values.put(finalA, { source: 'A host' });
            await targetStorage.values.put(finalB, { source: 'B host' });
            await targetStorage.freshness.put(finalA, 'potentially-outdated');
            await targetStorage.freshness.put(finalB, 'potentially-outdated');

            const hostStorage = db.hostnameSchemaStorage('ident-host');
            await writeGraphScheme(hostStorage);
            await hostStorage.values.put(hostA, { source: 'A host' });
            await hostStorage.values.put(hostB, { source: 'B host' });
            await hostStorage.valid.put(hostA, [hostB]);
            const hostLookup = makeIdentifierLookup([[hostA, keyA], [hostB, keyB]]);

            const targetSourceStorage = db.schemaStorageForReplica('x');
            await writeGraphScheme(targetSourceStorage);
            const targetLookup = makeIdentifierLookup([]);

            const finalIdentifierForKey = new Map([[keyA, finalA], [keyB, finalB]]);
            const valueOriginByKey = new Map([
                [keyA, { kind: 'source', side: 'host', sourceId: hostA }],
                [keyB, { kind: 'source', side: 'host', sourceId: hostB }],
            ]);

            await rebuildMergedValidity({
                targetStorage,
                targetSourceStorage,
                hostSourceStorage: hostStorage,
                targetLookup,
                hostLookup,
                finalIdentifierForKey,
                mergedInputsMap: new Map([[finalB, [finalA]]]),
                valueOriginByKey,
            });

            expect(String(finalA)).not.toBe(String(hostA));
            expect(String(finalB)).not.toBe(String(hostB));
            const validA = await targetStorage.valid.get(finalA) ?? [];
            expect(validA.some(dependent => String(dependent) === String(finalB))).toBe(true);
        } finally {
            if (db) await db.close();
        }
    });

    test('5. direct relowering with value deletion does not preserve validity', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const targetA = nodeIdentifierFromString('114-abcdefghi');
            const hostB = nodeIdentifierFromString('117-abcdefghi');
            const hostA = nodeIdentifierFromString('116-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"del_A","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"del_B","args":[]}');

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, targetA, TS3, { source: 'A target' });
            await writeIdentifierLookup(L, [[targetA, keyA]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeNode(H, hostA, TS1, { source: 'A host' });
            await writeNode(H, hostB, TS2, { source: 'B host' });
            await H.valid.put(hostA, [hostB]);
            await writeIdentifierLookup(H, [[hostA, keyA], [hostB, keyB]]);

            db = await mergeAndReopenIfSwitched(capabilities, logger, db, hostname);

            const T = db.getSchemaStorage();
            // A is kept (target-newer, TS3 > TS1): finalA = targetA
            // B is taken (host-newer, TS2 > no target B): finalB = hostB
            // B depends on A (via scheme). B's source inputs use hostLookup -> hostA.
            // B's final inputs use finalIdentifierForKey -> targetA (A kept).
            // hostA != targetA => direct relowering => B's value deleted, origin none.
            // host-side proof valid[hostA] = [hostB] must NOT transport.
            // hostA is deleted (A kept from target), so valid[hostA] doesn't exist.
            expect(await T.values.get(hostB)).toBeUndefined();
            expect(await T.freshness.get(hostB)).toBe('potentially-outdated');
            const validTargetA = await T.valid.get(targetA) ?? [];
            expect(validTargetA.some(dependent => String(dependent) === String(hostB))).toBe(false);
            expect(await T.valid.get(hostA) ?? []).toEqual([]);
        } finally {
            if (db) await db.close();
        }
    });

    test('6. invalidation propagation walks through stale nodes', async () => {
        const testCapabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(testCapabilities);

            const nodeA = nodeIdentifierFromString('117-abcdefghi');
            const nodeB = nodeIdentifierFromString('118-abcdefghi');
            const nodeC = nodeIdentifierFromString('119-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"prop_A","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"prop_B","args":[]}');
            const keyC = stringToNodeKeyString('{"head":"prop_C","args":[]}');

            const L = db.schemaStorageForReplica('x');
            await writeNode(L, nodeA, TS1, { v: 1 });
            await writeNode(L, nodeB, TS1, { v: 2 });
            await writeNode(L, nodeC, TS1, { v: 3 });
            await L.valid.put(nodeA, [nodeB]);
            await L.valid.put(nodeB, [nodeC]);
            await L.freshness.put(nodeB, 'potentially-outdated');
            await L.freshness.put(nodeC, 'up-to-date');
            await writeIdentifierLookup(L, [[nodeA, keyA], [nodeB, keyB], [nodeC, keyC]]);

            // Reload DB to populate in-memory identifier lookup from LevelDB
            await db.close();
            db = await getRootDatabase(testCapabilities);

            // constructorIncrementalGraph handles fresh DB initialization (version + graph_scheme).
            // The scheme derived from these nodeDefs must match what's needed for invalidation
            // propagation (linear A→B→C chain).

            const graph = await createIncrementalGraph(testCapabilities, db, [
                { output: 'prop_A', inputs: [], computor: async () => ({ v: 2 }), isDeterministic: true, hasSideEffects: false },
                { output: 'prop_B', inputs: ['prop_A'], computor: async () => ({ v: 2 }), isDeterministic: true, hasSideEffects: false },
                { output: 'prop_C', inputs: ['prop_B'], computor: async () => ({ v: 3 }), isDeterministic: true, hasSideEffects: false },
            ]);

            await graph.invalidate('prop_A');
            await graph.pull('prop_A');

            const schema = db.getSchemaStorage();
            const cFreshness = await schema.freshness.get(nodeC);
            expect(cFreshness).toBe('potentially-outdated');
        } finally {
            if (db) await db.close();
        }
    });

    test('7. final merge validation rejects an up-to-date node with a stale input', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);

            const nodeA = nodeIdentifierFromString('120-abcdefghi');
            const nodeB = nodeIdentifierFromString('121-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"stale_input_A","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"stale_input_B","args":[]}');

            const T = db.schemaStorageForReplica('x');
            await writeGraphScheme(T);

            await T.values.put(nodeA, { v: 1 });
            await T.values.put(nodeB, { v: 2 });
            await T.freshness.put(nodeA, 'potentially-outdated');
            await T.freshness.put(nodeB, 'up-to-date');
            await T.valid.put(nodeA, [nodeB]);

            const lookup = makeIdentifierLookup([
                [nodeA, keyA],
                [nodeB, keyB],
            ]);

            await expect(
                assertValidFinalMergeState(T, lookup)
            ).rejects.toThrow(FinalMergeStateError);
        } finally {
            if (db) await db.close();
        }
    });

    test('rejects host materialized node with missing timestamps and keeps active replica', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const nodeA = nodeIdentifierFromString('133-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"host_stale_A","args":[]}');
            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await H.values.put(nodeA, { v: 'host' });
            await H.freshness.put(nodeA, 'up-to-date');
            await writeIdentifierLookup(H, [[nodeA, keyA]]);

            await expect(mergeHostIntoReplica(logger, db, hostname)).rejects.toThrow(IdentifierLookupConflictError);
            expect(db.currentReplicaName()).toBe('x');
        } finally {
            if (db) await db.close();
        }
    });

    test('rejects target materialized node with missing timestamps and keeps active replica', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            const logger = makeLogger();
            const hostname = 'peer';
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal(hostname, 'version', db.version);

            const nodeA = nodeIdentifierFromString('134-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"host_stale_A","args":[]}');
            const L = db.schemaStorageForReplica('x');
            await L.values.put(nodeA, { v: 'target' });
            await L.freshness.put(nodeA, 'up-to-date');
            await writeIdentifierLookup(L, [[nodeA, keyA]]);

            const H = db.hostnameSchemaStorage(hostname);
            await writeGraphScheme(H);
            await writeIdentifierLookup(H, []);

            await expect(mergeHostIntoReplica(logger, db, hostname)).rejects.toThrow(IdentifierLookupConflictError);
            expect(db.currentReplicaName()).toBe('x');
        } finally {
            if (db) await db.close();
        }
    });

    test('final merge validation rejects up-to-date materialized node with missing timestamps', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const nodeA = nodeIdentifierFromString('135-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"host_stale_A","args":[]}');
            const T = db.schemaStorageForReplica('x');
            await writeGraphScheme(T);
            await T.values.put(nodeA, { v: 'final' });
            await T.freshness.put(nodeA, 'up-to-date');
            const lookup = makeIdentifierLookup([[nodeA, keyA]]);
            await expect(assertValidFinalMergeState(T, lookup)).rejects.toThrow(FinalMergeStateError);
        } finally {
            if (db) await db.close();
        }
    });



    test('invalidation propagation terminates through an already-stale cycle', async () => {
        const { internalPropagateOutdated } = require('../src/generators/incremental_graph/invalidate');
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const storage = db.getSchemaStorage();
            const nodeA = nodeIdentifierFromString('126-abcdefghi');
            const nodeB = nodeIdentifierFromString('127-abcdefghi');
            await storage.values.put(nodeA, { v: 'A' });
            await storage.values.put(nodeB, { v: 'B' });
            await storage.freshness.put(nodeA, 'potentially-outdated');
            await storage.freshness.put(nodeB, 'potentially-outdated');
            await storage.valid.put(nodeA, [nodeB]);
            await storage.valid.put(nodeB, [nodeA]);

            const graph = await createIncrementalGraph(capabilities, db, []);
            await graph.storage.withTransaction(async (tx) => {
                await internalPropagateOutdated(graph, nodeA, tx.batch);
                return { value: undefined };
            });

            expect(await storage.freshness.get(nodeA)).toBe('potentially-outdated');
            expect(await storage.freshness.get(nodeB)).toBe('potentially-outdated');
        } finally {
            if (db) await db.close();
        }
    });

    test('final merge validation rejects an up-to-date node with missing input freshness', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const nodeA = nodeIdentifierFromString('128-abcdefghi');
            const nodeB = nodeIdentifierFromString('129-abcdefghi');
            const keyA = stringToNodeKeyString('{"head":"stale_input_A","args":[]}');
            const keyB = stringToNodeKeyString('{"head":"stale_input_B","args":[]}');
            const T = db.schemaStorageForReplica('x');
            await writeGraphScheme(T);
            await T.values.put(nodeA, { v: 1 });
            await T.values.put(nodeB, { v: 2 });
            await T.freshness.put(nodeB, 'up-to-date');
            await T.valid.put(nodeA, [nodeB]);
            const lookup = makeIdentifierLookup([[nodeA, keyA], [nodeB, keyB]]);
            await expect(assertValidFinalMergeState(T, lookup)).rejects.toThrow(FinalMergeStateError);
        } finally {
            if (db) await db.close();
        }
    });

    test('throws IdentifierLookupConflictError when same identifier maps to different semantic keys', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
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
            await writeGraphScheme(H);
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
