/**
 * The render -> scan -> merge path that carries a Journal-backed replica into the
 * per-host fieldwise merge.
 *
 * `docs/specs/incremental-graph-journal-sync.md` (`IncrementalGraph-facing behavior`)
 * states that synchronization does not merge `values`, `freshness`, timestamps, `valid`,
 * or identifier maps fieldwise as independent authorities. `mergeHostIntoReplica` is that
 * fieldwise merge, so it refuses a Journal-backed merge source instead of reusing another
 * writer's materialized rows.
 *
 * That refusal only protects the merge if the Journal sublevel survives
 * `renderToFilesystem` and `scanFromFilesystem` into the `_h_<hostname>` staging
 * namespace. A Journal-backed replica which arrived in staging looking Journal-free would
 * arrive as exactly the materialized replica the fieldwise engine is allowed to merge, so
 * these tests drive the whole pipeline — real publications, a real render, a real scan
 * into staging — instead of hand-built staging storage.
 *
 * Each test names the merge source it holds Journal-free, and asserts the refusal's role,
 * so no single Journal-backed source can make the whole suite green. The control holds the
 * two replicas and the pipeline identical and differs only in whether the staged snapshot
 * keeps its Journal sublevel, which is what makes the refusal attributable to the Journal
 * state and to nothing else.
 */

const path = require('path');

const {
    getRootDatabase,
    renderToFilesystem,
    scanFromFilesystem,
} = require('../src/generators/incremental_graph/database');
const {
    mergeHostIntoReplica,
    isJournalBackedFieldwiseMergeError,
} = require('../src/generators/incremental_graph/database/sync_merge');
const { createIncrementalGraph } = require('../src/generators/incremental_graph');
const { JOURNAL_STATE_KEY } = require('../src/generators/incremental_graph/journal_store');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');
const { numberComputedValue } = require('./computed_value_fixture');

/** @typedef {import('../src/generators/incremental_graph/database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('../src/generators/incremental_graph/database/root_database').SchemaStorage} SchemaStorage */

jest.setTimeout(30000);

const HOSTNAME = 'peer';

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
 * @returns {{ logInfo: Function, logDebug: Function, logWarning: Function, logError: Function }}
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
 * The committed-pair state record a real publication writes into a replica's Journal
 * sublevel. Its presence is what makes that replica Journal-backed.
 *
 * @param {RootDatabase} db
 * @returns {Promise<string | undefined>}
 */
async function readJournalState(db) {
    const storage = db.schemaStorageForReplica(db.currentReplicaName());
    return storage.journal.get(JOURNAL_STATE_KEY);
}

/**
 * Open a database, build a real single-node graph over it, and publish one graph
 * transition. Every graph row and every Journal row in the returned replica was written
 * by the production computation, emission, and publication path.
 *
 * @param {ReturnType<typeof getMockedRootCapabilities>} capabilities
 * @returns {Promise<RootDatabase>}
 */
async function publishReplica(capabilities) {
    const db = await getRootDatabase(capabilities);
    const graph = await createIncrementalGraph(capabilities, db, [
        {
            output: 'root',
            inputs: [],
            computor: async () => numberComputedValue(1),
            isDeterministic: true,
            hasSideEffects: false,
        },
    ]);
    await graph.pull('root');
    await db.setGlobalVersion(db.getVersion());
    return db;
}

/**
 * Render a source replica to a snapshot directory and scan it into the receiver's
 * hostname staging namespace, which is what `synchronize.js` does with a remote worktree
 * before it calls `mergeHostIntoReplica`.
 *
 * @param {ReturnType<typeof getMockedRootCapabilities>} sourceCapabilities
 * @param {RootDatabase} source
 * @param {ReturnType<typeof getMockedRootCapabilities>} receiverCapabilities
 * @param {RootDatabase} receiver
 * @param {string} hostname
 * @returns {Promise<string>} The staging sublevel the snapshot was scanned into.
 */
async function renderScanIntoStaging(sourceCapabilities, source, receiverCapabilities, receiver, hostname) {
    const snapshotDir = await receiverCapabilities.creator.createTemporaryDirectory();
    const replicaDir = path.join(snapshotDir, 'r');
    const stagingSublevel = '_h_' + hostname;
    await renderToFilesystem(sourceCapabilities, source, replicaDir, source.currentReplicaName());
    await scanFromFilesystem(receiverCapabilities, receiver, replicaDir, stagingSublevel);
    await receiver.setHostnameGlobal(hostname, 'version', receiver.getVersion());
    return stagingSublevel;
}

/**
 * @param {RootDatabase} db
 * @param {string} sublevel
 * @returns {Promise<Map<string, unknown>>}
 */
async function readSublevelRows(db, sublevel) {
    const rows = new Map();
    for await (const [key, value] of db._rawEntriesForSublevel(sublevel)) {
        rows.set(key, value);
    }
    return rows;
}

/**
 * Merge once and report either the outcome or the error, so a refusal is asserted without
 * the caller having to know which stage raised it.
 *
 * @param {RootDatabase} db
 * @param {string} hostname
 * @returns {Promise<boolean | Error>}
 */
async function mergeOutcome(db, hostname) {
    return mergeHostIntoReplica(makeLogger(), db, hostname).then(
        switched => switched,
        error => error
    );
}

describe('a replica reaching the fieldwise merge through render and scan', () => {
    test('refuses the staged host snapshot whose Journal sublevel came through the pipeline', async () => {
        const sourceCapabilities = getTestCapabilities();
        const receiverCapabilities = getTestCapabilities();
        let source;
        let receiver;
        try {
            source = await publishReplica(sourceCapabilities);
            expect(await readJournalState(source)).not.toBe(undefined);

            receiver = await publishReplica(receiverCapabilities);
            const stagedSublevel = await renderScanIntoStaging(
                sourceCapabilities, source, receiverCapabilities, receiver, HOSTNAME
            );

            // The receiver's own replica is a materialized replica with no Journal
            // sublevel, so a refusal can only name the staged host snapshot.
            await receiver.schemaStorageForReplica(receiver.currentReplicaName()).journal.clear();
            expect(await readJournalState(receiver)).toBe(undefined);
            expect(
                await receiver.hostnameSchemaStorage(HOSTNAME).journal.get(JOURNAL_STATE_KEY)
            ).not.toBe(undefined);

            const localBefore = await readSublevelRows(receiver, receiver.currentReplicaName());
            const inactiveBefore = await readSublevelRows(receiver, receiver.otherReplicaName());
            const stagedBefore = await readSublevelRows(receiver, stagedSublevel);

            const thrown = await mergeOutcome(receiver, HOSTNAME);

            expect(isJournalBackedFieldwiseMergeError(thrown)).toBe(true);
            expect(thrown.role).toBe('staged host snapshot');
            expect(thrown.hostname).toBe(HOSTNAME);
            expect(receiver.currentReplicaName()).toBe('x');
            expect(await readSublevelRows(receiver, 'x')).toEqual(localBefore);
            expect(await readSublevelRows(receiver, 'y')).toEqual(inactiveBefore);
            expect(await readSublevelRows(receiver, stagedSublevel)).toEqual(stagedBefore);
        } finally {
            if (source !== undefined) {
                await source.close();
            }
            if (receiver !== undefined) {
                await receiver.close();
            }
        }
    });

    test('refuses the local synchronization source whose Journal sublevel came from its own publication', async () => {
        const receiverCapabilities = getTestCapabilities();
        const peerCapabilities = getTestCapabilities();
        let receiver;
        let peer;
        try {
            receiver = await publishReplica(receiverCapabilities);
            expect(await readJournalState(receiver)).not.toBe(undefined);

            peer = await publishReplica(peerCapabilities);
            await peer.schemaStorageForReplica(peer.currentReplicaName()).journal.clear();
            const stagedSublevel = await renderScanIntoStaging(
                peerCapabilities, peer, receiverCapabilities, receiver, HOSTNAME
            );

            // The staged snapshot is a materialized replica with no Journal sublevel, so
            // a refusal can only name the local synchronization source.
            expect(
                await receiver.hostnameSchemaStorage(HOSTNAME).journal.get(JOURNAL_STATE_KEY)
            ).toBe(undefined);

            const localBefore = await readSublevelRows(receiver, receiver.currentReplicaName());
            const inactiveBefore = await readSublevelRows(receiver, receiver.otherReplicaName());
            const stagedBefore = await readSublevelRows(receiver, stagedSublevel);

            const thrown = await mergeOutcome(receiver, HOSTNAME);

            expect(isJournalBackedFieldwiseMergeError(thrown)).toBe(true);
            expect(thrown.role).toBe('local synchronization source');
            expect(thrown.hostname).toBe(HOSTNAME);
            expect(receiver.currentReplicaName()).toBe('x');
            expect(await readSublevelRows(receiver, 'x')).toEqual(localBefore);
            expect(await readSublevelRows(receiver, 'y')).toEqual(inactiveBefore);
            expect(await readSublevelRows(receiver, stagedSublevel)).toEqual(stagedBefore);
        } finally {
            if (receiver !== undefined) {
                await receiver.close();
            }
            if (peer !== undefined) {
                await peer.close();
            }
        }
    });

    test('the same pipeline and the same replica rows merge once the staged Journal sublevel is absent', async () => {
        const sourceCapabilities = getTestCapabilities();
        const receiverCapabilities = getTestCapabilities();
        let source;
        let receiver;
        try {
            source = await publishReplica(sourceCapabilities);
            receiver = await publishReplica(receiverCapabilities);
            const stagedSublevel = await renderScanIntoStaging(
                sourceCapabilities, source, receiverCapabilities, receiver, HOSTNAME
            );
            await receiver.schemaStorageForReplica(receiver.currentReplicaName()).journal.clear();

            const staged = receiver.hostnameSchemaStorage(HOSTNAME);
            const stagedJournalRowsBefore = new Set(await readSublevelRows(receiver, stagedSublevel));
            expect(stagedJournalRowsBefore.size).toBeGreaterThan(0);

            // Drop only the Journal sublevel of the staged snapshot, leaving every graph
            // row the pipeline delivered exactly as it is.
            await staged.journal.clear();
            expect(
                await receiver.hostnameSchemaStorage(HOSTNAME).journal.get(JOURNAL_STATE_KEY)
            ).toBe(undefined);

            const outcome = await mergeOutcome(receiver, HOSTNAME);

            expect(outcome instanceof Error).toBe(false);
            expect(isJournalBackedFieldwiseMergeError(outcome)).toBe(false);
        } finally {
            if (source !== undefined) {
                await source.close();
            }
            if (receiver !== undefined) {
                await receiver.close();
            }
        }
    });
});