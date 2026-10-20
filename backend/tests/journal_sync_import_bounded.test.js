/**
 * A foreign suffix longer than the in-memory work-queue limit is streamed, not accumulated.
 *
 * `incremental-graph-journal-sync.md` §Streamability and `$id-4924739474925738` require
 * the complete newly transferred suffix to be consumable incrementally and never held as
 * one in-RAM collection. The acquisition already holds each imported writer's range and a
 * re-readable positioned reader rather than its records; these tests pin that the
 * computation which consumes the plan does the same.
 *
 * Three things are pinned:
 *
 * - the outcome exposes a streaming `recordGrowth`, not a materialised `records` array, so
 *   a pre-fix implementation which collected the suffix fails the first assertion;
 * - folding the growth one record at a time yields the complete imported suffix plus the
 *   authored records, so streaming does not drop a record; and
 * - the production publication front stages the growth into a real inactive replica in
 *   bounded chunks, so no single durable write holds the suffix.
 */

const {
    getRootDatabase,
    RAW_BATCH_CHUNK_SIZE,
} = require("../src/generators/incremental_graph/database");

const {
    isRecordGrowth,
    SnapshotIdentityClass,
    synchronizeRetainedJournal,
} = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
} = require("../src/generators/incremental_graph/journal_retained");

const {
    journalAuthorToString,
    journalRecordIdToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeJournalSequence,
    makeReplicaSource,
    makeValueEvent,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const {
    publishSyncReceiverOutcome,
} = require("../src/generators/incremental_graph/journal_publish/sync_publication");

const {
    readRetainedJournal,
} = require("../src/generators/incremental_graph/journal_store");

const { getMockedRootCapabilities } = require("./spies");
const { stubDatetime, stubEnvironment, stubLogger } = require("./stubs");

const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const PAYLOAD = { type: "entry_description", description: "x" };
const INSTANT = 1700000000000;

/**
 * The imported suffix length, chosen to be several chunks so a front which staged the
 * whole suffix at once would issue one oversized batch.
 */
const IMPORT_LENGTH = 2 * RAW_BATCH_CHUNK_SIZE + 100;

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
 * @param {number} id
 * @returns {import("../src/generators/incremental_graph/journal").NodeKey}
 */
function nodeOf(id) {
    return { head: "event", args: [{ id }] };
}

/**
 * The receiver's one local leaf occurrence, which the imported suffix observes.
 *
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
 */
function localLeaf() {
    return made(makeValueEvent(
        {
            id: WRITER_LOCAL + ":1",
            context: makeJournalFrontierFromText([]),
            authorityTime: authorityOf(1),
            node: nodeOf(0),
        },
        "0-abcdefghi",
        PAYLOAD,
        NOW,
        LATER,
        "compute"
    ));
}

/**
 * A foreign chain of `count` leaf occurrences with exact own-prefix contexts, each
 * observing the receiver's complete frontier.
 *
 * @param {number} count
 * @param {string} receiverHead
 * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
 */
function peerChain(count, receiverHead) {
    /** @type {Array<import("../src/generators/incremental_graph/journal").JournalRecord>} */
    const records = [];
    for (let sequence = 1; sequence <= count; sequence += 1) {
        const context = sequence === 1
            ? [[WRITER_LOCAL, receiverHead]]
            : [[WRITER_LOCAL, receiverHead], [WRITER_PEER, String(sequence - 1)]];
        records.push(made(makeValueEvent(
            {
                id: WRITER_PEER + ":" + String(sequence),
                context: makeJournalFrontierFromText(context),
                authorityTime: authorityOf(100000 + sequence),
                node: nodeOf(1000 + sequence),
            },
            String(1000 + sequence) + "-abcdefghi",
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        )));
    }
    return records;
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {import("../src/generators/incremental_graph/journal").JournalReplica}
 */
function replicaOf(records) {
    /** @type {Map<string, import("../src/generators/incremental_graph/journal").JournalRecord[]>} */
    const byWriter = new Map();
    for (const record of records) {
        const writerName = journalAuthorToString(record.id.author);
        const stream = byWriter.get(writerName) ?? [];
        stream.push(record);
        byWriter.set(writerName, stream);
    }
    return makeJournalReplica([...byWriter.entries()]);
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} receiver
 * @returns {Promise<import("../src/generators/incremental_graph/journal_retained").RetainedReplayState>}
 */
async function retainedStateOf(receiver) {
    const built = await buildRetainedReplayState({
        source: makeReplicaSource(replicaOf(receiver)),
        localWriter: made(makeJournalAuthor(WRITER_LOCAL)),
        currentInputKeysOfNode: () => [],
    });
    if ("error" in built) {
        throw new Error("the receiver's retained state could not be built: " + built.error.message);
    }
    return built.state;
}

/**
 * @returns {import("../src/generators/incremental_graph/journal").CommittedWriterState}
 */
function committedState() {
    return {
        localWriter: made(makeJournalAuthor(WRITER_LOCAL)),
        writerHead: made(makeJournalSequence("1")),
        committedFrontier: makeJournalFrontierFromText([[WRITER_LOCAL, "1"]]),
        authorityHighWater: authorityOf(1),
        allocatorWatermark: 0,
    };
}

/**
 * Run the production synchronization of a foreign chain into the one-leaf receiver.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} receiver
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} source
 * @returns {Promise<import("../src/generators/incremental_graph/journal_sync").SyncOutcome>}
 */
async function synchronize(receiver, source) {
    const identity = new SnapshotIdentityClass("v1", "scheme");
    const result = await synchronizeRetainedJournal({
        receiver: makeReplicaSource(replicaOf(receiver)),
        source: makeReplicaSource(replicaOf(source)),
        localWriter: made(makeJournalAuthor(WRITER_LOCAL)),
        committed: committedState(),
        observedHighWater: authorityOf(1),
        publicationInstant: INSTANT,
        currentInputKeysOfNode: () => [],
        receiverIdentity: identity,
        sourceIdentity: identity,
        retainedState: await retainedStateOf(receiver),
    });
    if (!("outcome" in result)) {
        throw new Error("synchronization failed with " + result.error.name + ": " + result.error.message);
    }
    return result.outcome;
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

describe("a foreign suffix longer than the work-queue limit", () => {
    test("is exposed as a streaming growth, not a materialised records array", async () => {
        const receiver = [localLeaf()];
        const source = peerChain(IMPORT_LENGTH, "1");
        const outcome = await synchronize(receiver, source);

        // The pre-fix accumulation exposed `outcome.records` as an array; the streaming
        // outcome must not.
        expect(outcome.records).toBeUndefined();
        expect(isRecordGrowth(outcome.recordGrowth)).toBe(true);

        // Folding the growth one record at a time yields the complete imported suffix.
        /** @type {Array<string>} */
        const streamed = [];
        await outcome.recordGrowth.forEachRecord((record) => {
            streamed.push(journalRecordIdToString(record.id));
        });
        expect(streamed).toHaveLength(IMPORT_LENGTH);
        expect(streamed[0]).toBe(WRITER_PEER + ":1");
        expect(streamed[streamed.length - 1]).toBe(WRITER_PEER + ":" + String(IMPORT_LENGTH));

        // Collecting the same growth reproduces the same sequence.
        const collected = await outcome.recordGrowth.collect();
        expect(collected.map((record) => journalRecordIdToString(record.id))).toEqual(streamed);
        expect(nodeKeyToCanonicalString(collected[0].node)).toBe(
            nodeKeyToCanonicalString(nodeOf(1001))
        );
    });

    test("is staged into a real inactive replica in bounded chunks by the production front", async () => {
        const capabilities = capabilitiesFor();
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

        const receiver = [localLeaf()];
        const source = peerChain(IMPORT_LENGTH, "1");
        const outcome = await synchronize(receiver, source);

        const db = await getRootDatabase(capabilities);
        try {
            issued.length = 0;
            const target = db.syncStagingStorage();
            await publishSyncReceiverOutcome({
                target,
                retainedSource: makeReplicaSource(replicaOf(receiver)),
                receiverVersion: "1.0.0",
                receiverGraphScheme: "scheme",
                receiverFingerprint: WRITER_LOCAL,
                outcome,
            });

            const recordBatches = issued.filter(
                (keys) => keys.length > 0 && keys.every((key) => key.includes("record|"))
            );
            expect(recordBatches.length).toBeGreaterThan(1);
            for (const keys of recordBatches) {
                expect(keys.length).toBeLessThanOrEqual(RAW_BATCH_CHUNK_SIZE);
            }
            const staged = recordBatches.reduce((total, keys) => total + keys.length, 0);
            // The receiver's one retained record plus the complete imported suffix.
            expect(staged).toBe(1 + IMPORT_LENGTH);

            const replica = await readRetainedJournal(target.journal);
            if (replica instanceof Error) {
                throw replica;
            }
            const retained = [...replica.values()].flat();
            expect(retained).toHaveLength(1 + IMPORT_LENGTH);
        } finally {
            await db.close();
        }
    });
});
