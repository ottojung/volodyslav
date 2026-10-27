/**
 * A mid-staging fault leaves the active replica pointer unchanged; a retry cutovers.
 *
 * `incremental-graph-journal-sync.md` §Atomic publication permits staging into
 * inactive durable storage with the active state changing only at the final
 * replica-pointer cutover. This test drives the production cutover front,
 * `installSyncOutcome`, over a real LevelDB with a retained history longer than
 * `RAW_BATCH_CHUNK_SIZE`: it injects a durable failure into the second staging
 * chunk, requires the install to fail with the active pointer unchanged, clears
 * the fault, retries, and requires the pointer to move with every retained
 * record staged.
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
    ProjectionClass,
} = require("../src/generators/incremental_graph/journal");

const {
    makeEmptyRetainedReplayState,
} = require("../src/generators/incremental_graph/journal_retained");

const {
    makeRecordGrowth,
} = require("../src/generators/incremental_graph/journal_sync");

const {
    installSyncOutcome,
} = require("../src/generators/incremental_graph/journal_publish/sync_publication");

const {
    readRetainedJournal,
} = require("../src/generators/incremental_graph/journal_store");

const { getMockedRootCapabilities } = require("./spies");
const { stubDatetime, stubEnvironment, stubLogger } = require("./stubs");

const WRITER_LOCAL = "aaaaaaaaa";
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const PAYLOAD = { type: "entry_description", description: "x" };

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
 * @param {object} capabilities
 * @returns {{ issued: Array<Array<string>>, failOn: (predicate: (keys: Array<string>) => boolean) => void, clearFault: () => void }}
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
        clearFault() {
            failure = undefined;
        },
    };
}

/**
 * @param {Array<string>} keys
 * @returns {boolean}
 */
function isRecordBatch(keys) {
    return keys.length > 0 && keys.every((key) => key.includes("record|"));
}

/**
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

describe("a mid-staging fault leaves the active replica pointer unchanged", () => {
    test("fault fails before cutover; retry stages everything and moves the pointer", async () => {
        const capabilities = capabilitiesFor();
        const batches = instrumentBatches(capabilities);
        const db = await getRootDatabase(capabilities);
        try {
            const activeBefore = db.currentReplicaName();
            const inactive = db.otherReplicaName();
            const retainedSource = makeReplicaSource(
                makeJournalReplica([[WRITER_LOCAL, retainedChain(HISTORY_LENGTH)]])
            );

            let recordBatchesSeen = 0;
            batches.failOn((keys) => {
                if (!isRecordBatch(keys)) {
                    return false;
                }
                recordBatchesSeen += 1;
                return recordBatchesSeen === 2;
            });

            await expect(installSyncOutcome({
                rootDatabase: db,
                targetReplica: inactive,
                publication: {
                    target: db.schemaStorageForReplica(inactive),
                    retainedSource,
                    receiverVersion: "1.0.0",
                    receiverGraphScheme: "scheme",
                    receiverFingerprint: WRITER_LOCAL,
                    outcome: emptyOutcome(),
                },
            })).rejects.toThrow("injected staging failure");
            expect(db.currentReplicaName()).toBe(activeBefore);

            batches.clearFault();
            batches.issued.length = 0;
            const moved = await installSyncOutcome({
                rootDatabase: db,
                targetReplica: inactive,
                publication: {
                    target: db.schemaStorageForReplica(inactive),
                    retainedSource,
                    receiverVersion: "1.0.0",
                    receiverGraphScheme: "scheme",
                    receiverFingerprint: WRITER_LOCAL,
                    outcome: emptyOutcome(),
                },
            });
            expect(moved).toBe(inactive);
            expect(db.currentReplicaName()).toBe(inactive);

            const recordBatches = batches.issued.filter(isRecordBatch);
            expect(recordBatches.length).toBeGreaterThan(1);
            for (const keys of recordBatches) {
                expect(keys.length).toBeLessThanOrEqual(RAW_BATCH_CHUNK_SIZE);
            }
            const staged = recordBatches.reduce((total, keys) => total + keys.length, 0);
            expect(staged).toBe(HISTORY_LENGTH);

            const replica = await readRetainedJournal(
                db.schemaStorageForReplica(inactive).journal
            );
            if (replica instanceof Error) {
                throw replica;
            }
            expect([...replica.values()].flat()).toHaveLength(HISTORY_LENGTH);
        } finally {
            await db.close();
        }
    });
});
