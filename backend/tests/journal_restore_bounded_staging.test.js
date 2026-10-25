/**
 * Absent-state restore stages a history-sized snapshot in bounded chunks.
 *
 * `database-lifecycle.md` §4.2 restores a completely absent installation from a
 * held continuation-safe snapshot. The snapshot's retained history is
 * history-sized, so `restoreAbsentFrom` stages it into the fresh database first,
 * in chunks of at most `RAW_BATCH_CHUNK_SIZE`, and the final batch carries only
 * the graph-sized cutover: the projection, the committed-pair writer state and
 * the maintained proof summary.
 *
 * Both cases drive the real production entry point against a real LevelDB
 * holding a chain publication of `2 * CHAIN_LENGTH + 1` records, which exceeds
 * `RAW_BATCH_CHUNK_SIZE` several times over. Each case asserts the batch shape:
 * every record-only durable batch is at most `RAW_BATCH_CHUNK_SIZE`, more than
 * one such batch is issued, and exactly one graph-and-journal batch is the
 * atomic cutover. The fault case rejects a full-size record staging chunk and
 * requires the cutover batch to never run, which leaves the fresh database
 * without installed journal state; the retry case then re-stages over the
 * abandoned partial stage and restores the complete snapshot.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const {
    getRootDatabase,
    RAW_BATCH_CHUNK_SIZE,
} = require("../src/generators/incremental_graph/database");
const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const {
    readRetainedJournal,
    readCommittedWriterState,
    JOURNAL_STATE_KEY,
} = require("../src/generators/incremental_graph/journal_store");
const {
    makeReplicaSource,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal/oracle");
const {
    makeContinuationSafeSnapshot,
    restoreAbsentFrom,
} = require("../src/generators/incremental_graph/journal_recovery_source");
const {
    deriveInputPositions,
    GRAPH_SCHEME_KEY,
} = require("../src/generators/incremental_graph/database/graph_scheme");
const { LAST_NODE_INDEX_KEY } = require("../src/generators/incremental_graph/database");
const { journalAuthorToString } = require("../src/generators/incremental_graph/journal");

const { getMockedRootCapabilities } = require("./spies");
const { stubDatetime, stubEnvironment, stubLogger } = require("./stubs");

jest.setTimeout(180000);

/**
 * The chain length. A real publication of this chain emits `2 * length + 1`
 * records, so `length` is chosen so the snapshot history is several chunks long
 * and unambiguously exceeds the bounded chunk size.
 */
const CHAIN_LENGTH = 600;

/**
 * @param {string} label
 * @returns {object}
 */
function capabilitiesFor(label) {
    fs.mkdtempSync(path.join(os.tmpdir(), `journal-restore-bounded-${label}-`));
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

/**
 * A chain graph of `length` independent deterministic leaves. Each node depends on its
 * predecessor, so pulling the last head materializes the whole chain.
 *
 * @param {object} capabilities
 * @param {object} db
 * @param {number} length
 * @returns {Promise<import("../src/generators/incremental_graph").IncrementalGraph>}
 */
async function makeChainGraph(capabilities, db, length) {
    /** @type {Array<import("../src/generators/incremental_graph/types").NodeDef>} */
    const nodeDefs = [];
    for (let index = 0; index < length; index += 1) {
        nodeDefs.push({
            output: "leaf_" + String(index),
            inputs: index === 0 ? [] : ["leaf_" + String(index - 1)],
            computor: async () => ({
                type: "entry_description",
                description: "leaf " + String(index),
            }),
            isDeterministic: true,
            hasSideEffects: false,
        });
    }
    return await createIncrementalGraph(capabilities, db, nodeDefs);
}

/**
 * Record, per durable batch the process issues, the keys its operations address.
 *
 * @param {object} capabilities
 * @returns {Array<Array<string>>}
 */
function instrumentBatches(capabilities) {
    /** @type {Array<Array<string>>} */
    const issued = [];
    const initialize = capabilities.levelDatabase.initialize;
    capabilities.levelDatabase.initialize = (databasePath) => {
        const level = initialize(databasePath);
        const batch = level.batch.bind(level);
        level.batch = (operations) => {
            issued.push(operations.map((operation) => String(operation.key)));
            return batch(operations);
        };
        return level;
    };
    return issued;
}

/**
 * Every key of a batch is a Journal record key, which is exactly one staging chunk.
 *
 * @param {ReadonlyArray<string>} keys
 * @returns {boolean}
 */
function isRecordBatch(keys) {
    return keys.length > 0 && keys.every((key) => key.includes("record|"));
}

/**
 * A batch which carries both a Journal write and a graph write, which is the shape of the
 * one atomic cutover the absent-state restore ends with.
 *
 * @param {ReadonlyArray<Array<string>>} issued
 * @returns {Array<Array<string>>}
 */
function graphAndJournalBatches(issued) {
    return issued.filter(
        (keys) =>
            keys.some((key) => key.includes("journal")) &&
            keys.some((key) => key.includes("values") || key.includes("timestamps"))
    );
}

/**
 * Read one live database's retained journal, committed writer state and materialized
 * projection into a continuation-safe recovery snapshot.
 *
 * @param {object} db
 * @returns {Promise<object>}
 */
async function continuationSafeSnapshotOf(db) {
    const storage = db.getSchemaStorage();
    const replica = await readRetainedJournal(storage.journal);
    if (replica instanceof Error) {
        throw replica;
    }
    const committed = await readCommittedWriterState(storage.journal, db.getFingerprint());
    if (committed instanceof Error) {
        throw committed;
    }
    const graphSchemeString = await storage.global.get(GRAPH_SCHEME_KEY);
    const currentInputKeysOfNode = (nodeKeyString) => {
        try {
            return deriveInputPositions(graphSchemeString, nodeKeyString);
        } catch (error) {
            return [];
        }
    };
    const projection = await projectRetainedJournal({
        source: makeReplicaSource(replica),
        localWriter: committed.localWriter,
        currentInputKeysOfNode,
    });
    if (projection instanceof Error) {
        throw projection;
    }
    const snapshot = makeContinuationSafeSnapshot({
        localWriter: committed.localWriter,
        records: [...replica.values()].flat(),
        projection,
        writerState: committed,
        databaseVersion: await storage.global.get("version"),
        graphSchemeString,
    });
    if (snapshot instanceof Error) {
        throw snapshot;
    }
    return snapshot;
}

/**
 * Publish the whole chain in a source database and hold its synchronized state as
 * a continuation-safe snapshot whose history exceeds the bounded chunk size.
 *
 * @param {string} label
 * @returns {Promise<{snapshot: object, recordCount: number}>}
 */
async function buildSnapshotOverChunkSize(label) {
    const capabilities = capabilitiesFor(label + "-source");
    const db = await getRootDatabase(capabilities);
    try {
        const graph = await makeChainGraph(capabilities, db, CHAIN_LENGTH);
        await graph.pull("leaf_" + String(CHAIN_LENGTH - 1));
        const snapshot = await continuationSafeSnapshotOf(db);
        expect(snapshot.records.length).toBeGreaterThan(RAW_BATCH_CHUNK_SIZE);
        return { snapshot, recordCount: snapshot.records.length };
    } finally {
        await db.close();
    }
}

/**
 * The retained journal record count of one replica namespace.
 *
 * @param {object} db
 * @returns {Promise<number>}
 */
async function retainedRecordCount(db) {
    const replica = await readRetainedJournal(db.getSchemaStorage().journal);
    if (replica instanceof Error) {
        throw replica;
    }
    return [...replica.values()].flat().length;
}

/**
 * Assert the bounded-staging shape a real production restore must have.
 *
 * @param {ReadonlyArray<Array<string>>} issued
 */
function assertBoundedStaging(issued) {
    const recordBatches = issued.filter(isRecordBatch);
    expect(recordBatches.length).toBeGreaterThan(1);
    for (const keys of recordBatches) {
        expect(keys.length).toBeLessThanOrEqual(RAW_BATCH_CHUNK_SIZE);
    }
    expect(graphAndJournalBatches(issued)).toHaveLength(1);
}

describe("absent-state restore stages a snapshot history longer than the chunk size in bounded batches", () => {
    test("the restore stages records in bounded chunks and cuts over once", async () => {
        const { snapshot, recordCount } = await buildSnapshotOverChunkSize("restore");
        const capabilities = capabilitiesFor("restore");
        const issued = instrumentBatches(capabilities);
        await restoreAbsentFrom(capabilities, snapshot);

        assertBoundedStaging(issued);

        const db = await getRootDatabase(capabilities);
        try {
            expect(await retainedRecordCount(db)).toBe(recordCount);
            const storage = db.getSchemaStorage();
            await expect(storage.global.get("fingerprint")).resolves.toBe(
                journalAuthorToString(snapshot.localWriter)
            );
            await expect(storage.global.get(LAST_NODE_INDEX_KEY)).resolves.toBe(
                snapshot.writerState.allocatorWatermark
            );
            let values = 0;
            for await (const identifier of storage.values.keys()) {
                expect(identifier).toBeDefined();
                values += 1;
            }
            expect(values).toBe(CHAIN_LENGTH);
        } finally {
            await db.close();
        }
    });

    test("a fault during record staging fails before cutover and a retry restores cleanly", async () => {
        const { snapshot, recordCount } = await buildSnapshotOverChunkSize("restore-fault");
        const capabilities = capabilitiesFor("restore-fault");

        let rejectStagingChunk = false;
        const initialize = capabilities.levelDatabase.initialize;
        capabilities.levelDatabase.initialize = (databasePath) => {
            const level = initialize(databasePath);
            const batch = level.batch.bind(level);
            level.batch = (operations) => {
                const keys = operations.map((operation) => String(operation.key));
                // Reject the first full-size record-only chunk, so the cutover
                // batch never runs.
                if (rejectStagingChunk && isRecordBatch(keys) && keys.length === RAW_BATCH_CHUNK_SIZE) {
                    return Promise.reject(new Error("injected restore staging failure"));
                }
                return batch(operations);
            };
            return level;
        };

        // The first attempt abandons a partial stage but never installs journal
        // state, because the cutover batch is the only write which does.
        rejectStagingChunk = true;
        await expect(restoreAbsentFrom(capabilities, snapshot)).rejects.toThrow(
            "injected restore staging failure"
        );

        const partial = await getRootDatabase(capabilities);
        try {
            await expect(partial.getSchemaStorage().journal.get(JOURNAL_STATE_KEY)).resolves.toBeUndefined();
            expect(await retainedRecordCount(partial)).toBeLessThan(recordCount);
        } finally {
            await partial.close();
        }

        // A retry with the fault removed re-stages the same deterministic record
        // keys over the abandoned stage and then installs the complete snapshot.
        rejectStagingChunk = false;
        await restoreAbsentFrom(capabilities, snapshot);

        const db = await getRootDatabase(capabilities);
        try {
            expect(await retainedRecordCount(db)).toBe(recordCount);
            await expect(db.getSchemaStorage().journal.get(JOURNAL_STATE_KEY)).resolves.toBeDefined();
        } finally {
            await db.close();
        }
    });
});
