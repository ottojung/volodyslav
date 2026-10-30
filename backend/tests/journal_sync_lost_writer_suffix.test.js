/**
 * A replica which has lost a surviving suffix of its own writer history is refused.
 *
 * `incremental-graph-journal-testing.md` §Corruption tests requires a boundary which
 * newly admits or constructs state to reject "evidence that an existing local writer
 * has lost a surviving suffix". A replica publishes its committed-pair metadata in the
 * same atomic write as the records it names, so its retained own-writer length is
 * exactly the committed `writerHead`. A retained length below that head is the lost
 * suffix, and `incremental-graph-journal-sync.md` §Receiver-local writer ahead in the
 * source is unsupported state gives the receiver no supported same-writer recovery, so
 * the condition fails closed.
 *
 * The three layers that must all enforce it are pinned here: the shared
 * `reconcileRetainedWriterHead` read, the semantic synchronization entry, and the two
 * production readers `readJournalSource` and `readRetainedJournal`.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const {
    makeJournalRecordKey,
    readCommittedWriterState,
    readJournalSource,
    readRetainedJournal,
    reconcileRetainedWriterHead,
} = require("../src/generators/incremental_graph/journal_store");
const {
    isJournalWriterBehindError,
    journalAuthorToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeJournalSequence,
    makeReplicaSource,
    makeValueEvent,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeDeleteEvent,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const {
    SnapshotIdentityClass,
    synchronizeRetainedJournal,
} = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
} = require("../src/generators/incremental_graph/journal_retained");

const allEventsModule = require("../src/generators/individual/all_events/wrapper");
const metaEventsComputor = require("../src/generators/individual/meta_events/wrapper").computor;
const eventContextComputor = require("../src/generators/individual/event_context/wrapper").computor;

const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const { stubDatetime, stubEnvironment, stubLogger } = require("./stubs");

jest.setTimeout(120000);

const NODE_A = { head: "event", args: [{ id: 1 }] };
const NODE_B = { head: "event", args: [{ id: 2 }] };
const KEY_A = nodeKeyToCanonicalString(NODE_A);
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const PAYLOAD = { type: "entry_description", description: "x" };
const INSTANT = 1700000000000;

/**
 * @param {unknown} value
 * @returns {any}
 */
function made(value) {
    if (value instanceof Error) {
        throw new Error("fixture built an invalid record: " + value.message);
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
 * @param {string} nodeKeyString
 * @returns {string}
 */
function identifierOf(nodeKeyString) {
    return JSON.parse(nodeKeyString).args[0].id + "-abcdefghi";
}

/**
 * Build one writer's value+validate pair for a node occurrence.
 *
 * @param {object} occurrence
 * @returns {Array<object>}
 */
function materialize(occurrence) {
    const nodeKey = nodeKeyToCanonicalString(occurrence.node);
    const valueId = occurrence.writer + ":" + occurrence.sequence;
    const valueSequence = String(Number(occurrence.sequence) + 1);
    const observed = Number(occurrence.sequence) - 1 === 0
        ? [...occurrence.context]
        : [...occurrence.context, [occurrence.writer, String(Number(occurrence.sequence) - 1)]];
    const observedByValue = Number(valueSequence) - 1 === 0
        ? [...occurrence.context]
        : [...occurrence.context, [occurrence.writer, String(Number(valueSequence) - 1)]];
    return [
        made(makeValueEvent(
            {
                id: valueId,
                context: makeJournalFrontierFromText(observed),
                authorityTime: authorityOf(Number(occurrence.sequence)),
                node: occurrence.node,
            },
            occurrence.identifier === undefined ? identifierOf(nodeKey) : occurrence.identifier,
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        )),
        made(makeValidateEvent(
            {
                id: occurrence.writer + ":" + valueSequence,
                context: makeJournalFrontierFromText(observedByValue),
                authorityTime: authorityOf(Number(valueSequence)),
                node: occurrence.node,
            },
            valueId,
            occurrence.basis.map((entry) => makeValidationBasisEntry(entry.node, entry.value)),
            "compute"
        )),
    ];
}

/**
 * @param {ReadonlyArray<object>} records
 * @returns {import("../src/generators/incremental_graph/journal").JournalReplica}
 */
function replicaOf(records) {
    const byWriter = new Map();
    for (const record of records) {
        const name = journalAuthorToString(record.id.author);
        const stream = byWriter.get(name) ?? [];
        stream.push(record);
        byWriter.set(name, stream);
    }
    return made(makeJournalReplica([...byWriter.entries()]));
}

/**
 * The receiver chain: local writer records 1..4, where B requires A.
 * @returns {Array<object>}
 */
function receiverChain() {
    return [
        ...materialize({ writer: WRITER_LOCAL, sequence: "1", node: NODE_A, context: [], basis: [] }),
        ...materialize({
            writer: WRITER_LOCAL,
            sequence: "3",
            node: NODE_B,
            context: [],
            basis: [{ node: NODE_A, value: WRITER_LOCAL + ":1" }],
        }),
    ];
}

/**
 * @param {Array<object>} records
 * @param {string} [localWriter]
 * @returns {import("../src/generators/incremental_graph/journal_retained").RetainedReplayState}
 */
async function rebuiltStateOf(records, localWriter = WRITER_LOCAL) {
    const built = await buildRetainedReplayState({
        source: makeReplicaSource(replicaOf(records)),
        localWriter: makeJournalAuthor(localWriter),
        currentInputKeysOfNode: (nodeKeyString) => (nodeKeyString === KEY_A ? [] : [KEY_A]),
    });
    if ("error" in built) {
        throw new Error("retained state rebuild failed: " + built.error.message);
    }
    return built.state;
}

describe("a lost surviving own-writer suffix is refused", () => {
    test("reconcileRetainedWriterHead rejects a retained length behind the committed head", () => {
        const source = makeReplicaSource(replicaOf(receiverChain()));
        const committed = {
            localWriter: made(makeJournalAuthor(WRITER_LOCAL)),
            writerHead: made(makeJournalSequence("6")),
        };
        const failure = reconcileRetainedWriterHead(source, committed);
        expect(isJournalWriterBehindError(failure)).toBe(true);
    });

    test("reconcileRetainedWriterHead accepts a retained length equal to the committed head", () => {
        const source = makeReplicaSource(replicaOf(receiverChain()));
        const committed = {
            localWriter: made(makeJournalAuthor(WRITER_LOCAL)),
            writerHead: made(makeJournalSequence("4")),
        };
        expect(reconcileRetainedWriterHead(source, committed)).toBeUndefined();
    });

    test("synchronization refuses a receiver whose committed writerHead exceeds its retained length", async () => {
        const receiver = receiverChain();
        const committed = {
            localWriter: made(makeJournalAuthor(WRITER_LOCAL)),
            writerHead: made(makeJournalSequence("6")),
            committedFrontier: makeJournalFrontierFromText([[WRITER_LOCAL, "6"]]),
            authorityHighWater: authorityOf(700),
            allocatorWatermark: 0,
        };
        const source = [
            made(makeDeleteEvent(
                {
                    id: WRITER_PEER + ":1",
                    context: makeJournalFrontierFromText([[WRITER_LOCAL, "4"]]),
                    authorityTime: authorityOf(100),
                    node: NODE_A,
                },
                "operation"
            )),
        ];

        const result = await synchronizeRetainedJournal({
            receiver: makeReplicaSource(replicaOf(receiver)),
            source: makeReplicaSource(replicaOf(source)),
            localWriter: made(makeJournalAuthor(WRITER_LOCAL)),
            committed,
            observedHighWater: authorityOf(700),
            publicationInstant: INSTANT,
            currentInputKeysOfNode: (nodeKeyString) => (nodeKeyString === KEY_A ? [] : [KEY_A]),
            receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
            sourceIdentity: new SnapshotIdentityClass("v1", "scheme"),
            retainedState: await rebuiltStateOf(receiver),
        });

        expect("outcome" in result).toBe(false);
        if ("outcome" in result) {
            return;
        }
        expect(isJournalWriterBehindError(result.error)).toBe(true);
    });

    test("synchronization accepts a receiver whose committed writerHead matches its retained length", async () => {
        const receiver = receiverChain();
        const committed = {
            localWriter: made(makeJournalAuthor(WRITER_LOCAL)),
            writerHead: made(makeJournalSequence("4")),
            committedFrontier: makeJournalFrontierFromText([[WRITER_LOCAL, "4"]]),
            authorityHighWater: authorityOf(4),
            allocatorWatermark: 0,
        };

        const result = await synchronizeRetainedJournal({
            receiver: makeReplicaSource(replicaOf(receiver)),
            source: makeReplicaSource(replicaOf([])),
            localWriter: made(makeJournalAuthor(WRITER_LOCAL)),
            committed,
            observedHighWater: authorityOf(4),
            publicationInstant: INSTANT,
            currentInputKeysOfNode: (nodeKeyString) => (nodeKeyString === KEY_A ? [] : [KEY_A]),
            receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
            sourceIdentity: new SnapshotIdentityClass("v1", "scheme"),
            retainedState: await rebuiltStateOf(receiver),
        });

        expect("outcome" in result).toBe(true);
    });
});

const CREATOR = {
    name: "tester",
    uuid: "0f6c1a1e-0000-4000-8000-000000000000",
    version: "1.0.0",
    hostname: "host.example",
};

/**
 * @param {object} capabilities
 * @param {object} db
 * @returns {Promise<import("../src/generators/incremental_graph").IncrementalGraph>}
 */
async function makeRealGraph(capabilities, db) {
    const box = allEventsModule.makeBox();
    box.value = [
        {
            id: eventId.fromString("aaaaaaaaa:1"),
            date: fromISOString("2020-01-01T09:00:00.000Z"),
            original: "the receiver wrote this",
            input: "the receiver wrote this",
            creator: CREATOR,
        },
    ];
    return await createIncrementalGraph(capabilities, db, [
        {
            output: "all_events",
            inputs: [],
            computor: allEventsModule.makeComputor(box, {}),
            isDeterministic: false,
            hasSideEffects: false,
        },
        {
            output: "meta_events",
            inputs: ["all_events"],
            computor: metaEventsComputor,
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "event_context",
            inputs: ["meta_events"],
            computor: eventContextComputor,
            isDeterministic: true,
            hasSideEffects: false,
        },
    ]);
}

/**
 * @returns {object}
 */
function testCapabilities() {
    fs.mkdtempSync(path.join(os.tmpdir(), "journal-lost-suffix-"));
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("the production readers reconcile the retained length against the committed head", () => {
    test("readJournalSource and readRetainedJournal reject a record deleted behind the committed head", async () => {
        const capabilities = testCapabilities();
        const database = await getRootDatabase(capabilities);
        try {
            const graph = await makeRealGraph(capabilities, database);
            await graph.pull("event_context");

            const replica = database.currentReplicaName();
            const fingerprint = database.getFingerprint();
            const storage = database.schemaStorageForReplica(replica);
            const committed = await readCommittedWriterState(storage.journal, fingerprint);
            expect(committed instanceof Error).toBe(false);
            if (committed instanceof Error) {
                return;
            }

            const author = makeJournalAuthor(fingerprint);
            expect(author instanceof Error).toBe(false);
            if (author instanceof Error) {
                return;
            }
            const key = makeJournalRecordKey(author, committed.writerHead);
            expect(key instanceof Error).toBe(false);
            if (key instanceof Error) {
                return;
            }

            await storage.journal.del(key);

            const streamed = await readJournalSource(
                database.replicaJournalSublevel(replica),
                committed
            );
            expect(isJournalWriterBehindError(streamed)).toBe(true);

            const retained = await readRetainedJournal(storage.journal, committed);
            expect(isJournalWriterBehindError(retained)).toBe(true);
        } finally {
            await database.close();
        }
    });
});
