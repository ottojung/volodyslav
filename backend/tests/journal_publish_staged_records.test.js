/**
 * The retained-history half of a Journal publication is staged in bounded chunks.
 *
 * `incremental-graph-journal-sync.md` §Atomic publication and
 * `incremental-graph-journal-reset.md` §Atomicity permit a publication to stream into
 * inactive durable staging and change the active state only at the final cutover, while
 * `incremental-graph-journal-sync.md` §Streamability and `$id-4924739474925738` forbid the
 * complete retained Journal from being materialised in RAM as one collection.
 *
 * These tests drive the production publication front, `publishSyncReceiverOutcome`, over a
 * real LevelDB. The receiver's retained history is longer than `RAW_BATCH_CHUNK_SIZE`, so a
 * front which folded it into the single cutover batch would issue one batch of every
 * retained record. The bounded staging path instead issues a sequence of chunks, each no
 * larger than `RAW_BATCH_CHUNK_SIZE`, before the cutover batch.
 *
 * The mid-staging case injects a durable failure into the second staging chunk and requires
 * the publication to fail before the cutover state is written, which is what leaves the
 * previously activated replica active.
 */

const {
    getRootDatabase,
    RAW_BATCH_CHUNK_SIZE,
} = require("../src/generators/incremental_graph/database");

const {
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeJournalSequence,
    makeReplicaSource,
    makeValueEvent,
    nodeKeyToCanonicalString,
    ProjectionClass,
} = require("../src/generators/incremental_graph/journal");

const {
    makeEmptyRetainedReplayState,
} = require("../src/generators/incremental_graph/journal_retained");

const {
    makeRecordGrowth,
} = require("../src/generators/incremental_graph/journal_sync");

const {
    publishSyncReceiverOutcome,
} = require("../src/generators/incremental_graph/journal_publish/sync_publication");

const {
    JOURNAL_STATE_KEY,
    readRetainedJournal,
} = require("../src/generators/incremental_graph/journal_store");

const { getMockedRootCapabilities } = require("./spies");
const { stubDatetime, stubEnvironment, stubLogger } = require("./stubs");

const WRITER_LOCAL = "aaaaaaaaa";
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const PAYLOAD = { type: "entry_description", description: "x" };

/**
 * The retained history length, chosen to be several chunks so the staging path must issue
 * more than one bounded batch.
 */
const HISTORY_LENGTH = 2 * RAW_BATCH_CHUNK_SIZE + 200;

/**
 * @template T
 * @param {T | Error} value
 * @returns {T}
 */
function made(value) {
    if (value instanceof Error) {
        throw new Error("the fixture built an invalid value: " + value.message);
    }
    return value;
}

/**
 * @param {number} physical
 * @returns {import("../src/generators/incremental_graph/journal").AuthorityTime}
 */
function authorityOf(physical) {
    return made(makeAuthorityTime(physical, "0"));
}

/**
 * A chain of `count` own-writer value records with contiguous coordinates and exact
 * own-prefix contexts, which is a well-formed retained stream.
 *
 * @param {number} count
 * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
 */
function retainedChain(count) {
    /** @type {Array<import("../src/generators/incremental_graph/journal").JournalRecord>} */
    const records = [];
    for (let sequence = 1; sequence <= count; sequence += 1) {
        const node = { head: "event", args: [{ id: sequence }] };
        records.push(made(makeValueEvent(
            {
                id: WRITER_LOCAL + ":" + String(sequence),
                context: makeJournalFrontierFromText(
                    sequence === 1 ? [] : [[WRITER_LOCAL, String(sequence - 1)]]
                ),
                authorityTime: authorityOf(sequence),
                node,
            },
            String(sequence) + "-abcdefghi",
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        )));
    }
    return records;
}

/**
 * A source over the retained chain.
 *
 * @param {number} count
 * @returns {import("../src/generators/incremental_graph/journal").JournalSource}
 */
function retainedSourceOf(count) {
    return makeReplicaSource(makeJournalReplica([[WRITER_LOCAL, retainedChain(count)]]));
}

/**
 * The minimal publishable outcome a staging test needs: no imported or authored records and
 * an empty projection, so the cutover batch carries only the cutover state.
 *
 * @returns {object}
 */
function emptyOutcome() {
    const localWriter = made(makeJournalAuthor(WRITER_LOCAL));
    return {
        recordGrowth: makeRecordGrowth([], []),
        projection: new ProjectionClass([], new Map(), 0, localWriter, new Set(), new Set()),
        publication: {
            writerState: {
                localWriter,
                writerHead: made(makeJournalSequence(String(HISTORY_LENGTH))),
                committedFrontier: makeJournalFrontierFromText([
                    [WRITER_LOCAL, String(HISTORY_LENGTH)],
                ]),
                authorityHighWater: authorityOf(HISTORY_LENGTH + 1000),
                allocatorWatermark: 0,
            },
        },
        retainedState: makeEmptyRetainedReplayState(localWriter, () => []),
    };
}

/**
 * @returns {object}
 */
function capabilitiesFor() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

/**
 * Record, per durable batch, the keys its operations address.
 *
 * @param {object} capabilities
 * @returns {{ issued: Array<Array<string>>, failOn: (predicate: (keys: Array<string>) => boolean) => void }}
 */
function instrumentBatches(capabilities) {
    /** @type {Array<Array<string>>} */
    const issued = [];
    /** @type {((keys: Array<string>) => boolean) | undefined} */
    let failure = undefined;
    const initialize = capabilities.levelDatabase.initialize;
    capabilities.levelDatabase.initialize = (databasePath) => {
        const level = initialize(databasePath);
        const batch = level.batch.bind(level);
        level.batch = (operations) => {
            const keys = operations.map((operation) => String(operation.key));
            if (failure !== undefined && failure(keys)) {
                return Promise.reject(new Error("injected staging failure"));
            }
            issued.push(keys);
            return batch(operations);
        };
        return level;
    };
    return {
        issued,
        failOn(predicate) {
            failure = predicate;
        },
    };
}

/**
 * Whether every key of a batch is a Journal record key, which is exactly a staging chunk.
 *
 * @param {Array<string>} keys
 * @returns {boolean}
 */
function isRecordBatch(keys) {
    return keys.length > 0 && keys.every((key) => key.includes("record|"));
}

describe("the publication front stages retained history in bounded chunks", () => {
    test("a retained history longer than the chunk size is written in several bounded batches", async () => {
        const capabilities = capabilitiesFor();
        const batches = instrumentBatches(capabilities);
        const db = await getRootDatabase(capabilities);
        try {
            batches.issued.length = 0;
            const target = db.syncStagingStorage();
            await publishSyncReceiverOutcome({
                target,
                retainedSource: retainedSourceOf(HISTORY_LENGTH),
                receiverVersion: "1.0.0",
                receiverGraphScheme: "scheme",
                receiverFingerprint: WRITER_LOCAL,
                outcome: emptyOutcome(),
            });

            const recordBatches = batches.issued.filter(isRecordBatch);
            expect(recordBatches.length).toBeGreaterThan(1);
            for (const keys of recordBatches) {
                expect(keys.length).toBeLessThanOrEqual(RAW_BATCH_CHUNK_SIZE);
            }
            const staged = recordBatches.reduce((total, keys) => total + keys.length, 0);
            expect(staged).toBe(HISTORY_LENGTH);

            const replica = await readRetainedJournal(target.journal);
            if (replica instanceof Error) {
                throw replica;
            }
            const retained = [...replica.values()].flat();
            expect(retained).toHaveLength(HISTORY_LENGTH);
            expect(retained[0].id.sequence).toBeDefined();
            expect(nodeKeyToCanonicalString(retained[0].node)).toBe(
                nodeKeyToCanonicalString({ head: "event", args: [{ id: 1 }] })
            );
        } finally {
            await db.close();
        }
    });

    test("a fault in a staging chunk fails the publication before the cutover state is written", async () => {
        const capabilities = capabilitiesFor();
        const batches = instrumentBatches(capabilities);
        const db = await getRootDatabase(capabilities);
        try {
            batches.issued.length = 0;
            const target = db.syncStagingStorage();
            let recordBatchesSeen = 0;
            batches.failOn((keys) => {
                if (!isRecordBatch(keys)) {
                    return false;
                }
                recordBatchesSeen += 1;
                return recordBatchesSeen === 2;
            });

            await expect(publishSyncReceiverOutcome({
                target,
                retainedSource: retainedSourceOf(HISTORY_LENGTH),
                receiverVersion: "1.0.0",
                receiverGraphScheme: "scheme",
                receiverFingerprint: WRITER_LOCAL,
                outcome: emptyOutcome(),
            })).rejects.toThrow("injected staging failure");

            const replica = await readRetainedJournal(target.journal);
            if (replica instanceof Error) {
                throw replica;
            }
            const staged = [...replica.values()].flat();
            // The first chunk is durable and the rest is not: the cutover never ran.
            expect(staged).toHaveLength(RAW_BATCH_CHUNK_SIZE);

            const writerState = await target.journal.get(JOURNAL_STATE_KEY);
            expect(writerState).toBeUndefined();
        } finally {
            await db.close();
        }
    });
});
