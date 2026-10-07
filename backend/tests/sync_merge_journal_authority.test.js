/**
 * The per-host fieldwise merge refuses to run against a replica that carries
 * Journal state.
 *
 * `docs/specs/incremental-graph-journal-sync.md` (`IncrementalGraph-facing behavior`)
 * states that synchronization does not merge `values`, `freshness`, timestamps,
 * `valid`, or identifier maps fieldwise as independent authorities; the resulting
 * graph is `project(Jfinal)`. `mergeHostIntoReplica` implements exactly that fieldwise
 * merge, so for a Journal-backed replica it must refuse rather than reuse another
 * writer's materialized rows. These tests pin that refusal for both merge sources,
 * and pin that a replica without Journal state still merges fieldwise.
 */

const {
    GRAPH_SCHEME_KEY,
    IDENTIFIERS_KEY,
    getRootDatabase,
    makeIdentifierLookup,
    nodeIdentifierFromString,
    serializeIdentifierLookup,
    stringToJournalText,
    stringToNodeKeyString,
} = require('../src/generators/incremental_graph/database');
const {
    JournalBackedFieldwiseMergeError,
    isJournalBackedFieldwiseMergeError,
    mergeHostIntoReplica,
} = require('../src/generators/incremental_graph/database/sync_merge');
const {
    JOURNAL_STATE_KEY,
    makeInitialCommittedWriterState,
    serializeWriterState,
} = require('../src/generators/incremental_graph/journal_store');
const { makeJournalAuthor } = require('../src/generators/incremental_graph/journal');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');

jest.setTimeout(20000);

const HOSTNAME = 'peer';
const SCHEME = {
    format: 1,
    nodes: [{ head: "X", arity: 0, inputTemplates: [] }],
};
const LOCAL_NODE = nodeIdentifierFromString('201-abcdefghi');
const HOST_NODE = nodeIdentifierFromString('202-abcdefghi');
const NODE_KEY = stringToNodeKeyString('{"head":"X","args":[]}');
const LOCAL_TS = '2024-01-01T00:00:01.000Z';
const HOST_TS = '2024-01-01T00:00:05.000Z';

/**
 * @returns {ReturnType<typeof getMockedRootCapabilities>}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return capabilities;
}

/**
 * @returns {ReturnType<typeof makeLogger>}
 */
function makeLogger() {
    return {
        logInfo: jest.fn(),
        logDebug: jest.fn(),
        logWarning: jest.fn(),
        logError: jest.fn(),
    };
}

/**
 * Run the merge once and return either its boolean result or the error it threw, so a
 * refusal can be asserted without demanding a particular error type from the caller.
 *
 * @param {ReturnType<typeof makeLogger>} logger
 * @param {import('../src/generators/incremental_graph/database/root_database').RootDatabase} db
 * @returns {Promise<boolean | Error>}
 */
async function mergeOutcome(logger, db) {
    return mergeHostIntoReplica(logger, db, HOSTNAME).then(
        switched => switched,
        error => error
    );
}

/**
 * Write the committed-pair metadata a real publication leaves behind, so the
 * replica's Journal sublevel is non-empty exactly as it is after a graph transition.
 *
 * @param {import('../src/generators/incremental_graph/database/root_database').SchemaStorage} storage
 * @param {string} fingerprint
 * @returns {Promise<void>}
 */
async function writeJournalState(storage, fingerprint) {
    const state = makeInitialCommittedWriterState(makeJournalAuthor(fingerprint));
    if (state instanceof Error) {
        throw state;
    }
    await storage.journal.put(
        JOURNAL_STATE_KEY,
        stringToJournalText(JSON.stringify(serializeWriterState(state)))
    );
}

/**
 * @param {import('../src/generators/incremental_graph/database/root_database').SchemaStorage} storage
 * @param {import('../src/generators/incremental_graph/database').NodeIdentifier} nodeId
 * @param {string} modifiedAt
 * @returns {Promise<void>}
 */
async function writeNode(storage, nodeId, modifiedAt) {
    await storage.timestamps.put(nodeId, { createdAt: modifiedAt, modifiedAt });
    await storage.freshness.put(nodeId, 'up-to-date');
    await storage.values.put(nodeId, { count: 1 });
}

/**
 * Stage a two-sided merge fixture: a local replica and a staged host snapshot whose
 * node row for the same semantic key is newer, so a fieldwise merge would take the
 * host rows and switch the active replica pointer.
 *
 * @param {ReturnType<typeof getTestCapabilities>} capabilities
 * @param {{ journalOnLocal?: boolean, journalOnHost?: boolean }} options
 * @returns {Promise<{ db: import('../src/generators/incremental_graph/database/root_database').RootDatabase, logger: ReturnType<typeof makeLogger> }>}
 */
async function stageMergeFixture(capabilities, options) {
    const db = await getRootDatabase(capabilities);
    const logger = makeLogger();
    await db.setGlobalVersion(db.version);
    await db.setHostnameGlobal(HOSTNAME, 'version', db.version);

    const local = db.schemaStorageForReplica('x');
    await local.global.put(GRAPH_SCHEME_KEY, JSON.stringify(SCHEME));
    await local.global.put('fingerprint', 'zzzzzzzzz');
    await local.global.put(IDENTIFIERS_KEY, serializeIdentifierLookup(
        makeIdentifierLookup([[LOCAL_NODE, NODE_KEY]])
    ));
    await writeNode(local, LOCAL_NODE, LOCAL_TS);

    const host = db.hostnameSchemaStorage(HOSTNAME);
    await host.global.put(GRAPH_SCHEME_KEY, JSON.stringify(SCHEME));
    await host.global.put('fingerprint', 'aaaaaaaaa');
    await host.global.put(IDENTIFIERS_KEY, serializeIdentifierLookup(
        makeIdentifierLookup([[HOST_NODE, NODE_KEY]])
    ));
    await writeNode(host, HOST_NODE, HOST_TS);

    if (options.journalOnLocal === true) {
        await writeJournalState(local, 'zzzzzzzzz');
    }
    if (options.journalOnHost === true) {
        await writeJournalState(host, 'aaaaaaaaa');
    }

    return { db, logger };
}

/**
 * Read every graph sublevel row a fieldwise merge could rewrite, so a refusal can be
 * shown to leave both replicas byte-identical.
 *
 * @param {import('../src/generators/incremental_graph/database/root_database').SchemaStorage} storage
 * @returns {Promise<object>}
 */
async function readGraphSublevels(storage) {
    return {
        identifiers: await storage.global.get(IDENTIFIERS_KEY),
        graphScheme: await storage.global.get(GRAPH_SCHEME_KEY),
        values: await storage.values.get(LOCAL_NODE) ?? null,
        hostValues: await storage.values.get(HOST_NODE) ?? null,
        localFreshness: await storage.freshness.get(LOCAL_NODE) ?? null,
        hostFreshness: await storage.freshness.get(HOST_NODE) ?? null,
        localTimestamps: await storage.timestamps.get(LOCAL_NODE) ?? null,
        hostTimestamps: await storage.timestamps.get(HOST_NODE) ?? null,
    };
}

describe('mergeHostIntoReplica refuses the forbidden fieldwise merge on Journal state', () => {
    test('refuses when the local synchronization source carries Journal state', async () => {
        const capabilities = getTestCapabilities();
        const { db, logger } = await stageMergeFixture(capabilities, { journalOnLocal: true });
        try {
            const localBefore = await readGraphSublevels(db.schemaStorageForReplica('x'));
            const inactiveBefore = await readGraphSublevels(db.schemaStorageForReplica('y'));

            const thrown = await mergeOutcome(logger, db);

            expect(thrown).toBeInstanceOf(Error);
            expect(isJournalBackedFieldwiseMergeError(thrown)).toBe(true);
            expect(thrown).toBeInstanceOf(JournalBackedFieldwiseMergeError);
            expect(thrown.role).toBe('local synchronization source');
            expect(thrown.hostname).toBe(HOSTNAME);
            expect(db.currentReplicaName()).toBe('x');
            expect(await readGraphSublevels(db.schemaStorageForReplica('x'))).toEqual(localBefore);
            expect(await readGraphSublevels(db.schemaStorageForReplica('y'))).toEqual(inactiveBefore);
        } finally {
            await db.close();
        }
    });

    test('refuses when the staged host snapshot carries Journal state', async () => {
        const capabilities = getTestCapabilities();
        const { db, logger } = await stageMergeFixture(capabilities, { journalOnHost: true });
        try {
            const localBefore = await readGraphSublevels(db.schemaStorageForReplica('x'));
            const inactiveBefore = await readGraphSublevels(db.schemaStorageForReplica('y'));

            const thrown = await mergeOutcome(logger, db);

            expect(thrown).toBeInstanceOf(Error);
            expect(isJournalBackedFieldwiseMergeError(thrown)).toBe(true);
            expect(thrown.role).toBe('staged host snapshot');
            expect(db.currentReplicaName()).toBe('x');
            expect(await readGraphSublevels(db.schemaStorageForReplica('x'))).toEqual(localBefore);
            expect(await readGraphSublevels(db.schemaStorageForReplica('y'))).toEqual(inactiveBefore);
        } finally {
            await db.close();
        }
    });

    test('still merges fieldwise when neither source carries Journal state', async () => {
        const capabilities = getTestCapabilities();
        const { db, logger } = await stageMergeFixture(capabilities, {});
        try {
            expect(await mergeHostIntoReplica(logger, db, HOSTNAME)).toBe(true);

            const merged = db.schemaStorageForReplica(db.currentReplicaName());
            expect(await merged.timestamps.get(HOST_NODE)).toEqual({
                createdAt: HOST_TS,
                modifiedAt: HOST_TS,
            });
        } finally {
            await db.close();
        }
    });

    test('isJournalBackedFieldwiseMergeError identifies the error', () => {
        expect(isJournalBackedFieldwiseMergeError(
            new JournalBackedFieldwiseMergeError(HOSTNAME, 'staged host snapshot')
        )).toBe(true);
        expect(isJournalBackedFieldwiseMergeError(new Error('other'))).toBe(false);
    });
});