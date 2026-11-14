/**
 * The production sync/reset front over a real scanned-source replica whose foreign
 * suffix exceeds the bounded chunk size.
 *
 * `incremental-graph-journal-sync.md` §Streamability and
 * `incremental-graph-journal-reset.md` §Streamability require the complete transferred
 * suffix to be consumable incrementally, and `$id-4924739474925738` is the underlying
 * intent. The in-memory suite `journal_sync_import_bounded.test.js` pins the streaming
 * shape and the bounded staging with an in-memory source; `journal_publish_staged_records.test.js`
 * pins the retained half against a real LevelDB. Neither drives the *production* receiver
 * and reset entry points against a source replica that actually holds a foreign suffix
 * longer than `RAW_BATCH_CHUNK_SIZE`.
 *
 * This suite closes that gap. Both replicas are real publications of the same wide chain
 * graph: the receiver retains only the first node, while the held source replica retains
 * the whole chain. The source replica is a real scanned replica of a separately
 * fingerprinted database, so its records are a foreign writer's suffix of more than
 * `RAW_BATCH_CHUNK_SIZE` records. The production entry points then import it.
 *
 * Each case asserts the batch shape: every record-only durable batch is at most
 * `RAW_BATCH_CHUNK_SIZE`, more than one such batch is issued, and exactly one
 * graph-and-journal batch is the atomic cutover. The fault case injects a durable
 * failure into the imported-growth staging chunk and requires the previously activated
 * replica to be left exactly as it was, which is the failure-before-cutover guarantee.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const {
    getRootDatabase,
    RAW_BATCH_CHUNK_SIZE,
    renderToFilesystem,
    scanFromFilesystem,
    GRAPH_SCHEME_KEY,
    parseGraphScheme,
} = require("../src/generators/incremental_graph/database");

const {
    createIncrementalGraph,
    resetJournalReceiverToSnapshot,
    syncJournalReceiverToSource,
} = require("../src/generators/incremental_graph");

const { readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");
const { makeCurrentInputKeysOfNode } = require("../src/generators/incremental_graph/journal_bootstrap_startup");
const {
    journalAuthorToString,
    makeJournalAuthor,
    makeReplicaSource,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal");

const { getMockedRootCapabilities } = require("./spies");
const { stubDatetime, stubEnvironment, stubLogger } = require("./stubs");

jest.setTimeout(180000);

/**
 * The chain length. A real publication of this chain emits `2 * length + 1` records, so
 * `length` is chosen so the held source's foreign suffix is several chunks long and
 * unambiguously exceeds the bounded chunk size.
 */
const CHAIN_LENGTH = 600;

/**
 * @param {string} label
 * @returns {object}
 */
function capabilitiesFor(label) {
    fs.mkdtempSync(path.join(os.tmpdir(), `journal-import-production-${label}-`));
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
 * one atomic cutover §Atomic publication requires.
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
 * Build a receiver database retaining only the chain's first node and a separately
 * fingerprinted held-source database retaining the whole chain, then scan the source
 * database's replica into the receiver database's inactive replica.
 *
 * The receiver and the held source share one graph scheme, so they are a compatible
 * pair; the receiver's own records and the held source's records are authored by two
 * different fingerprints, so the held source's suffix is a genuine foreign suffix.
 *
 * @param {string} label
 * @returns {Promise<{database: object, capabilities: object, receiver: string, source: string, receiverFingerprint: string, sourceFingerprint: string}>}
 */
async function buildReceiverWithForeignSuffix(label) {
    const receiverCapabilities = capabilitiesFor(label);
    // Install the batch observer before the receiver database opens, so the already-open
    // LevelDB instance the production path later writes through is the wrapped one.
    const issued = instrumentBatches(receiverCapabilities);
    const receiver = await getRootDatabase(receiverCapabilities);
    const receiverGraph = await makeChainGraph(receiverCapabilities, receiver, CHAIN_LENGTH);
    await receiverGraph.pull("leaf_0");
    const receiverFingerprint = receiver.getFingerprint();
    const receiverReplica = receiver.currentReplicaName();
    const sourceReplica = receiver.otherReplicaName();

    const sourceCapabilities = capabilitiesFor(label + "-source");
    const sourceDatabase = await getRootDatabase(sourceCapabilities);
    const sourceGraph = await makeChainGraph(sourceCapabilities, sourceDatabase, CHAIN_LENGTH);
    await sourceGraph.pull("leaf_" + String(CHAIN_LENGTH - 1));
    const sourceFingerprint = sourceDatabase.getFingerprint();
    expect(sourceFingerprint).not.toBe(receiverFingerprint);

    const workTree = await receiverCapabilities.creator.createTemporaryDirectory();
    try {
        const replicaDirectory = path.join(workTree, "r");
        await renderToFilesystem(
            receiverCapabilities,
            sourceDatabase,
            replicaDirectory,
            sourceDatabase.currentReplicaName()
        );
        await scanFromFilesystem(receiverCapabilities, receiver, replicaDirectory, sourceReplica);
    } finally {
        await receiverCapabilities.deleter.deleteDirectory(workTree);
    }
    await sourceDatabase.close();

    return {
        database: receiver,
        capabilities: receiverCapabilities,
        receiver: receiverReplica,
        source: sourceReplica,
        receiverFingerprint,
        sourceFingerprint,
        issued,
    };
}

/**
 * The stored graph state of the activated replica, as one row per materialized node.
 *
 * @param {object} db
 * @returns {Promise<Map<string, object>>}
 */
async function storedRowsOf(db) {
    const storage = db.getSchemaStorage();
    /** @type {Map<string, object>} */
    const rows = new Map();
    for await (const identifier of storage.values.keys()) {
        rows.set(db.nodeIdToKey(identifier), {
            payload: await storage.values.get(identifier),
            freshness: await storage.freshness.get(identifier),
            timestamps: await storage.timestamps.get(identifier),
        });
    }
    return rows;
}

/**
 * The retained journal of one replica namespace.
 *
 * @param {object} db
 * @returns {Promise<Array<object>>}
 */
async function retainedRecordsOf(db) {
    const replica = await readRetainedJournal(db.getSchemaStorage().journal);
    if (replica instanceof Error) {
        throw replica;
    }
    return [...replica.values()].flat();
}

/**
 * Assert the bounded-staging shape a real production import must have.
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

describe("the production front imports a foreign suffix longer than the chunk size in bounded batches", () => {
    test("synchronization stages the imported suffix in bounded chunks and cuts over once", async () => {
        const built = await buildReceiverWithForeignSuffix("sync");
        const { database, capabilities, receiver, source, receiverFingerprint, sourceFingerprint, issued } = built;
        try {
            issued.length = 0;
            const changed = await syncJournalReceiverToSource({ database, capabilities, receiver, source });
            expect(changed).toBe(true);

            assertBoundedStaging(issued);

            const records = await retainedRecordsOf(database);
            const authors = new Set(records.map((record) => journalAuthorToString(record.id.author)));
            expect(authors.has(receiverFingerprint)).toBe(true);
            expect(authors.has(sourceFingerprint)).toBe(true);

            const localWriter = makeJournalAuthor(receiverFingerprint);
            if (localWriter instanceof Error) {
                throw localWriter;
            }
            const template = makeCurrentInputKeysOfNode(
                parseGraphScheme(await database.getSchemaStorage().global.get(GRAPH_SCHEME_KEY))
            );
            const projected = await projectRetainedJournal({
                source: makeReplicaSource(await readRetainedJournalOrThrow(database)),
                localWriter,
                currentInputKeysOfNode: (nodeKeyString) => template(nodeKeyString) ?? [],
            });
            if (projected instanceof Error) {
                throw projected;
            }
            expect(projected.occurrences.length).toBe(CHAIN_LENGTH);
        } finally {
            await database.close();
        }
    });

    test("reset stages the imported suffix in bounded chunks and cuts over once", async () => {
        const built = await buildReceiverWithForeignSuffix("reset");
        const { database, capabilities, receiver, source, receiverFingerprint, sourceFingerprint, issued } = built;
        try {
            issued.length = 0;
            const changed = await resetJournalReceiverToSnapshot({ database, capabilities, receiver, source });
            expect(changed).toBe(true);

            assertBoundedStaging(issued);

            const records = await retainedRecordsOf(database);
            const authors = new Set(records.map((record) => journalAuthorToString(record.id.author)));
            expect(authors.has(receiverFingerprint)).toBe(true);
            expect(authors.has(sourceFingerprint)).toBe(true);
        } finally {
            await database.close();
        }
    });

    test("a fault in the imported-growth staging leaves the previously activated replica active", async () => {
        const built = await buildReceiverWithForeignSuffix("sync-fault");
        const { database, capabilities, receiver, source } = built;
        const receiverReplica = database.currentReplicaName();
        const before = await storedRowsOf(database);
        await database.close();

        let rejectGrowthChunk = false;
        const initialize = capabilities.levelDatabase.initialize;
        capabilities.levelDatabase.initialize = (databasePath) => {
            const level = initialize(databasePath);
            const batch = level.batch.bind(level);
            level.batch = (operations) => {
                const keys = operations.map((operation) => String(operation.key));
                // Reject the first full-size record-only chunk. The receiver's own
                // retained records are a small first chunk; this is the first imported
                // growth chunk, so the cutover batch never runs.
                if (rejectGrowthChunk && isRecordBatch(keys) && keys.length === RAW_BATCH_CHUNK_SIZE) {
                    return Promise.reject(new Error("injected growth staging failure"));
                }
                return batch(operations);
            };
            return level;
        };

        const reopened = await getRootDatabase(capabilities);
        try {
            rejectGrowthChunk = true;
            await expect(
                syncJournalReceiverToSource({ database: reopened, capabilities, receiver, source })
            ).rejects.toThrow("injected growth staging failure");

            expect(reopened.currentReplicaName()).toBe(receiverReplica);
            expect(await storedRowsOf(reopened)).toEqual(before);
        } finally {
            await reopened.close();
        }
    });

    test("a retry after an imported-growth staging fault re-stages the full suffix and cuts over", async () => {
        const built = await buildReceiverWithForeignSuffix("sync-retry");
        const { database, capabilities, receiver, source, receiverFingerprint, sourceFingerprint } = built;
        const receiverReplica = database.currentReplicaName();
        const sourceReplica = database.otherReplicaName();
        await database.close();

        let rejectGrowthChunk = false;
        const initialize = capabilities.levelDatabase.initialize;
        capabilities.levelDatabase.initialize = (databasePath) => {
            const level = initialize(databasePath);
            const batch = level.batch.bind(level);
            level.batch = (operations) => {
                const keys = operations.map((operation) => String(operation.key));
                if (rejectGrowthChunk && isRecordBatch(keys) && keys.length === RAW_BATCH_CHUNK_SIZE) {
                    return Promise.reject(new Error("injected growth staging failure"));
                }
                return batch(operations);
            };
            return level;
        };

        const reopened = await getRootDatabase(capabilities);
        try {
            // The first attempt abandons a partial stage in the inactive replica but never
            // moves the pointer.
            rejectGrowthChunk = true;
            await expect(
                syncJournalReceiverToSource({ database: reopened, capabilities, receiver, source })
            ).rejects.toThrow("injected growth staging failure");
            expect(reopened.currentReplicaName()).toBe(receiverReplica);

            // A retry with the fault removed re-stages the same deterministic keys over the
            // abandoned stage and then cuts over to the complete suffix.
            rejectGrowthChunk = false;
            const changed = await syncJournalReceiverToSource({
                database: reopened,
                capabilities,
                receiver,
                source,
            });
            expect(changed).toBe(true);
            expect(reopened.currentReplicaName()).toBe(sourceReplica);

            const records = await retainedRecordsOf(reopened);
            const authors = new Set(records.map((record) => journalAuthorToString(record.id.author)));
            expect(authors.has(receiverFingerprint)).toBe(true);
            expect(authors.has(sourceFingerprint)).toBe(true);

            const localWriter = makeJournalAuthor(receiverFingerprint);
            if (localWriter instanceof Error) {
                throw localWriter;
            }
            const template = makeCurrentInputKeysOfNode(
                parseGraphScheme(await reopened.getSchemaStorage().global.get(GRAPH_SCHEME_KEY))
            );
            const projected = await projectRetainedJournal({
                source: makeReplicaSource(await readRetainedJournalOrThrow(reopened)),
                localWriter,
                currentInputKeysOfNode: (nodeKeyString) => template(nodeKeyString) ?? [],
            });
            if (projected instanceof Error) {
                throw projected;
            }
            expect(projected.occurrences.length).toBe(CHAIN_LENGTH);
        } finally {
            await reopened.close();
        }
    });
});

/**
 * @param {object} db
 * @returns {Promise<object>}
 */
async function readRetainedJournalOrThrow(db) {
    const replica = await readRetainedJournal(db.getSchemaStorage().journal);
    if (replica instanceof Error) {
        throw replica;
    }
    return replica;
}
