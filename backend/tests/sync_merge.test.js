const {
    GRAPH_SCHEME_KEY,
    IDENTIFIERS_KEY,
    getRootDatabase,
    makeIdentifierLookup,
    nodeIdentifierFromString,
    serializeIdentifierLookup,
    stringToNodeKeyString,
} = require('../src/generators/incremental_graph/database');
const {
    mergeHostIntoReplica,
    HostVersionMismatchError,
} = require('../src/generators/incremental_graph/database/sync_merge');
const {
    assertValidReplicaMaterializationState,
    isReplicaStateInvariantError,
} = require('../src/generators/incremental_graph/database/sync_merge_validation');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');

jest.setTimeout(20000);

const NODE_A = nodeIdentifierFromString('1-abcdefghi');
const NODE_B = nodeIdentifierFromString('2-abcdefghi');
const TS1 = '2024-01-01T00:00:01.000Z';
const TS2 = '2024-01-01T00:00:05.000Z';
const KEY_A = stringToNodeKeyString(JSON.stringify({ head: 'A', args: [] }));
const KEY_B = stringToNodeKeyString(JSON.stringify({ head: 'B', args: [] }));

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

async function writeGraphScheme(storage) {
    await storage.global.put(GRAPH_SCHEME_KEY, JSON.stringify({
        format: 1,
        nodes: [
            { head: 'A', arity: 0, inputTemplates: [] },
            { head: 'B', arity: 0, inputTemplates: [{ head: 'A', args: [] }] },
        ],
    }));
}

async function writeLookup(storage, entries) {
    await storage.global.put(IDENTIFIERS_KEY, serializeIdentifierLookup(makeIdentifierLookup(entries)));
}

async function writeNode(storage, id, freshness, modifiedAt, value) {
    await storage.values.put(id, value);
    await storage.freshness.put(id, freshness);
    await storage.timestamps.put(id, { createdAt: modifiedAt, modifiedAt });
}

async function writeCleanPair(storage, aId, bId, modifiedAt, aValue, bValue) {
    await writeLookup(storage, [[aId, KEY_A], [bId, KEY_B]]);
    await writeNode(storage, aId, 'up-to-date', modifiedAt, aValue);
    await writeNode(storage, bId, 'up-to-date', modifiedAt, bValue);
    await storage.valid.put(aId, [bId]);
}

describe('mergeHostIntoReplica', () => {
    test('throws HostVersionMismatchError when staged host version differs from local version', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            await writeGraphScheme(db.schemaStorageForReplica('x'));
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal('peer', 'version', 'incompatible-version');

            await expect(mergeHostIntoReplica(makeLogger(), db, 'peer')).rejects.toBeInstanceOf(HostVersionMismatchError);
        } finally {
            if (db) await db.close();
        }
    });

    test('takes a newer staged host value and leaves a valid materialized replica', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const active = db.schemaStorageForReplica('x');
            const host = db.hostnameSchemaStorage('peer');
            await writeGraphScheme(active);
            await writeGraphScheme(host);
            await db.setGlobalVersion(db.version);
            await db.setHostnameGlobal('peer', 'version', db.version);

            await writeCleanPair(active, NODE_A, NODE_B, TS1, { side: 'local-a' }, { side: 'local-b' });
            await writeCleanPair(host, NODE_A, NODE_B, TS2, { side: 'host-a' }, { side: 'host-b' });

            const switched = await mergeHostIntoReplica(makeLogger(), db, 'peer');

            expect(switched).toBe(true);
            expect(await db.getSchemaStorage().values.get(NODE_B)).toEqual({ side: 'host-b' });
            await assertValidReplicaMaterializationState(
                db.getSchemaStorage(),
                db.getActiveIdentifierLookup(),
                'active replica after merge'
            );
        } finally {
            if (db) await db.close();
        }
    });

    test('validator rejects identifier records that have no cached value', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const storage = db.schemaStorageForReplica('x');
            await writeGraphScheme(storage);
            const lookup = makeIdentifierLookup([[NODE_A, KEY_A]]);
            await writeLookup(storage, [[NODE_A, KEY_A]]);
            await storage.freshness.put(NODE_A, 'up-to-date');
            await storage.timestamps.put(NODE_A, { createdAt: TS1, modifiedAt: TS1 });

            let caught;
            try {
                await assertValidReplicaMaterializationState(storage, lookup, 'test replica');
            } catch (error) {
                caught = error;
            }

            expect(isReplicaStateInvariantError(caught)).toBe(true);
            expect(String(caught?.message)).toContain('has no cached value');
        } finally {
            if (db) await db.close();
        }
    });

    test('validator allows stale cached nodes with unmaterialized inputs', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const storage = db.schemaStorageForReplica('x');
            await writeGraphScheme(storage);
            const lookup = makeIdentifierLookup([[NODE_B, KEY_B]]);
            await writeLookup(storage, [[NODE_B, KEY_B]]);
            await writeNode(storage, NODE_B, 'potentially-outdated', TS1, { stale: true });

            await expect(assertValidReplicaMaterializationState(storage, lookup, 'test replica')).resolves.toBeUndefined();
        } finally {
            if (db) await db.close();
        }
    });
});
