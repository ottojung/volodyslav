/**
 * A held Journal source snapshot is only a source if it binds the records of one cut.
 *
 * `incremental-graph-journal-testing.md` §Stable source compatibility tests states that a
 * `JournalSnapshot` binds exact persisted version/schema, `localWriter`, frontier, and
 * records to one immutable source cut. The version/schema half is checked by the held
 * snapshot identity, and `journal_sync.test.js` and `journal_reset.test.js` cover a
 * version or graph-scheme mismatch. This suite covers the records half: a namespace which
 * materializes rows but retains no Journal record is a pre-Journal replica, not a
 * `JournalSnapshot`, and neither synchronization nor reset may treat it as one.
 *
 * Both shipped fronts enforce that with a dedicated guard before they read anything else
 * from the source — `syncJournalReceiverToSource` throws `SyncSourceIsNotAJournalSnapshotError`
 * and `resetJournalReceiverToSnapshot` throws `ResetSourceIsNotAJournalSnapshotError`. Those
 * guards are reachable from the production entry points and had no test, so this suite
 * drives the real fronts against a source namespace which carries a version, a graph
 * scheme and a fingerprint but retains no record, and against a genuine held snapshot
 * built by rendering and scanning one replica.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const {
    getRootDatabase,
    renderToFilesystem,
    scanFromFilesystem,
} = require("../src/generators/incremental_graph/database");
const {
    createIncrementalGraph,
    resetJournalReceiverToSnapshot,
    syncJournalReceiverToSource,
} = require("../src/generators/incremental_graph");
const {
    ResetSourceIsNotAJournalSnapshotError,
    SyncSourceIsNotAJournalSnapshotError,
} = require("../src/generators/incremental_graph/journal_publish");

const allEventsModule = require("../src/generators/individual/all_events/wrapper");
const metaEventsComputor = require("../src/generators/individual/meta_events/wrapper").computor;
const eventContextComputor = require("../src/generators/individual/event_context/wrapper").computor;

const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const { stubDatetime, stubEnvironment, stubLogger } = require("./stubs");

jest.setTimeout(120000);

const CREATOR = {
    name: "tester",
    uuid: "0f6c1a1e-0000-4000-8000-000000000000",
    version: "1.0.0",
    hostname: "host.example",
};

/**
 * The real graph both replicas run: three heads whose computors need neither a filesystem
 * nor an AI capability, so a publication is the production one.
 *
 * @param {object} capabilities
 * @param {object} db
 * @param {string} original
 * @returns {Promise<import("../src/generators/incremental_graph").IncrementalGraph>}
 */
async function makeRealGraph(capabilities, db, original) {
    const box = allEventsModule.makeBox();
    box.value = [
        {
            id: eventId.fromString("aaaaaaaaa:1"),
            date: fromISOString("2020-01-01T09:00:00.000Z"),
            original,
            input: original,
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
    fs.mkdtempSync(path.join(os.tmpdir(), "journal-stable-source-"));
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

/**
 * A database whose active replica is a production-published receiver and whose inactive
 * replica holds a filesystem-rendered copy of that same cut.
 *
 * Rendering the receiver's own active replica and scanning it into the inactive one gives
 * the operation a compatible held snapshot with a real retained journal and a real
 * committed projection. This is the same construction `journal_sync_streaming_source`
 * uses to make a genuine source snapshot, so the control cases below share it.
 *
 * @param {object} capabilities
 * @returns {Promise<{database: object, receiver: string, source: string}>}
 */
async function buildReceiverWithHeldSnapshot(capabilities) {
    const database = await getRootDatabase(capabilities);
    const graph = await makeRealGraph(capabilities, database, "the receiver wrote this");
    await graph.pull("event_context");

    const receiver = database.currentReplicaName();
    const source = database.otherReplicaName();
    const workTree = await capabilities.creator.createTemporaryDirectory();
    try {
        const replicaDirectory = path.join(workTree, "r");
        await renderToFilesystem(capabilities, database, replicaDirectory, receiver);
        await scanFromFilesystem(capabilities, database, replicaDirectory, source);
    } finally {
        await capabilities.deleter.deleteDirectory(workTree);
    }
    return { database, receiver, source };
}

/**
 * Turn a genuine held snapshot into a pre-Journal-shaped source: keep its version, graph
 * scheme and fingerprint, but remove every Journal record and occurrence so it retains
 * none. This is the shape of a checkpoint which materializes rows without retaining the
 * records which explain them.
 *
 * @param {object} database
 * @param {string} source
 * @returns {Promise<void>}
 */
async function stripJournalRecords(database, source) {
    await database.replicaJournalSublevel(source).clear();
}

describe("a held Journal source snapshot binds the records of its cut", () => {
    test("synchronization refuses a source which retains no Journal record", async () => {
        const capabilities = testCapabilities();
        const { database, receiver, source } = await buildReceiverWithHeldSnapshot(capabilities);
        try {
            await stripJournalRecords(database, source);
            const activeBefore = database.currentReplicaName();

            await expect(
                syncJournalReceiverToSource({ database, capabilities, receiver, source })
            ).rejects.toBeInstanceOf(SyncSourceIsNotAJournalSnapshotError);

            // The guard runs before any publication, so the receiver is untouched.
            expect(database.currentReplicaName()).toBe(activeBefore);
        } finally {
            await database.close();
        }
    });

    test("reset refuses a source which retains no Journal record", async () => {
        const capabilities = testCapabilities();
        const { database, receiver, source } = await buildReceiverWithHeldSnapshot(capabilities);
        try {
            await stripJournalRecords(database, source);
            const activeBefore = database.currentReplicaName();

            await expect(
                resetJournalReceiverToSnapshot({ database, capabilities, receiver, source })
            ).rejects.toBeInstanceOf(ResetSourceIsNotAJournalSnapshotError);

            expect(database.currentReplicaName()).toBe(activeBefore);
        } finally {
            await database.close();
        }
    });

    test("a genuine held snapshot which retains records is accepted by synchronization", async () => {
        const capabilities = testCapabilities();
        const { database, receiver, source } = await buildReceiverWithHeldSnapshot(capabilities);
        try {
            const changed = await syncJournalReceiverToSource({
                database,
                capabilities,
                receiver,
                source,
            });
            expect(changed).toBe(true);
        } finally {
            await database.close();
        }
    });

    test("a genuine held snapshot which retains records is accepted by reset", async () => {
        const capabilities = testCapabilities();
        const { database, receiver, source } = await buildReceiverWithHeldSnapshot(capabilities);
        try {
            const changed = await resetJournalReceiverToSnapshot({
                database,
                capabilities,
                receiver,
                source,
            });
            expect(changed).toBe(true);
        } finally {
            await database.close();
        }
    });
});
