/**
 * The production synchronization/reset front consumes retained records through the
 * per-writer streaming source, not through a materialized retained replica.
 *
 * `incremental-graph-journal-checklist.md` §9 requires that transfer/replay processing
 * satisfy `$id-4924739474925738` and that missing suffixes be incrementally iterable
 * without the complete retained history in RAM, and §11 requires the same of reset.
 * `readRetainedJournal` answers a replica by reading every stored record with one point
 * read per record key, so it materializes the whole retained journal before any
 * synchronization or reset can begin. `readJournalSource` is the streaming deployment of
 * the same records: it discovers each writer's retained length with one reverse range
 * read, reads a writer's records through that writer's own range iterator, and exposes
 * them only through the oracle's per-writer readers.
 *
 * These tests make the point-read shape unavailable: any root `get` whose key names a
 * Journal record throws. The production synchronization and the production reset are then
 * run to completion over a real database whose receiver and held snapshot each retain a
 * Journal. A front which fell back to `readRetainedJournal` would issue such a get and
 * fail; a front which consumes the streaming source never does. The guard observes the
 * one behavioral difference between the two readers, so the tests are not vacuous.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const {
    getRootDatabase,
    renderToFilesystem,
    scanFromFilesystem,
    stringToJournalText,
} = require("../src/generators/incremental_graph/database");
const {
    createIncrementalGraph,
    resetJournalReceiverToSnapshot,
    syncJournalReceiverToSource,
} = require("../src/generators/incremental_graph");
const {
    makeJournalRecordKey,
    readJournalSource,
} = require("../src/generators/incremental_graph/journal_store");
const {
    makeJournalAuthor,
    makeJournalSequence,
} = require("../src/generators/incremental_graph/journal");

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
 * The real graph both replicas run: three heads whose computors need neither a
 * filesystem nor an AI capability, so a publication is the production one.
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
    fs.mkdtempSync(path.join(os.tmpdir(), "journal-sync-streaming-"));
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

/**
 * Capture the LevelDB instance the database opens, so a guard can be installed on the
 * already-open instance after the fixture has been built.
 *
 * @param {object} capabilities
 * @returns {() => object}
 */
function interceptLevel(capabilities) {
    /** @type {object | undefined} */
    let level;
    const initialize = capabilities.levelDatabase.initialize;
    capabilities.levelDatabase.initialize = (databasePath) => {
        level = initialize(databasePath);
        return level;
    };
    return () => {
        if (level === undefined) {
            throw new Error("the database has not opened a LevelDB instance yet");
        }
        return level;
    };
}

/**
 * Make every point read of a Journal record value fail.
 *
 * A record's root-level key carries the `journal` sublevel name and the `record|` key
 * family prefix. The streaming source reads records only through range iterators and
 * reads each writer's length through one reverse range read, so it issues no such get;
 * `readRetainedJournal` reads one stored record per get, so it issues one per record.
 * The guard therefore turns "the front used `readRetainedJournal`" into a thrown error
 * while leaving every other read of the same database untouched.
 *
 * The guard is installed on the already-open instance, so it does not affect the
 * fixture's own filesystem rendering, which reads records by point get as the render
 * adapter is free to do.
 *
 * @param {object} level
 * @returns {Array<string>}
 */
function guardJournalRecordGets(level) {
    /** @type {Array<string>} */
    const recordGets = [];
    const get = level.get.bind(level);
    level.get = (key, ...rest) => {
        const text = String(key);
        if (text.includes("journal") && text.includes("record|")) {
            recordGets.push(text);
            throw new Error(
                "the production front read a Journal record through a point get: " + text
            );
        }
        return get(key, ...rest);
    };
    return recordGets;
}

/**
 * One database whose active replica is a production-published receiver and whose
 * inactive replica holds a filesystem-rendered copy of that same cut.
 *
 * Rendering the receiver's own active replica and scanning it into the inactive one
 * gives the operation a compatible held snapshot with a real retained journal and a
 * real committed projection, which is the whole of what synchronization and reset read
 * from the source side. The held snapshot and the receiver share a writer here, so the
 * tests exercise the read shape rather than a particular import outcome.
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

describe("the production Journal front streams retained records", () => {
    test("synchronization reads the receiver and the held snapshot without a record point read", async () => {
        const capabilities = testCapabilities();
        const levelOf = interceptLevel(capabilities);
        const { database, receiver, source } = await buildReceiverWithHeldSnapshot(capabilities);
        const recordGets = guardJournalRecordGets(levelOf());
        try {
            const changed = await syncJournalReceiverToSource({
                database,
                capabilities,
                receiver,
                source,
            });

            expect(changed).toBe(true);
            expect(recordGets).toEqual([]);
        } finally {
            await database.close();
        }
    });

    test("reset reads the receiver and the held snapshot without a record point read", async () => {
        const capabilities = testCapabilities();
        const levelOf = interceptLevel(capabilities);
        const { database, receiver, source } = await buildReceiverWithHeldSnapshot(capabilities);
        const recordGets = guardJournalRecordGets(levelOf());
        try {
            const changed = await resetJournalReceiverToSnapshot({
                database,
                capabilities,
                receiver,
                source,
            });

            expect(changed).toBe(true);
            expect(recordGets).toEqual([]);
        } finally {
            await database.close();
        }
    });

    test("the streaming source rejects a stored record it cannot decode", async () => {
        const capabilities = testCapabilities();
        const database = await getRootDatabase(capabilities);
        try {
            const graph = await makeRealGraph(capabilities, database, "the receiver wrote this");
            await graph.pull("event_context");

            const replica = database.currentReplicaName();
            const author = makeJournalAuthor(database.getFingerprint());
            expect(author instanceof Error).toBe(false);
            const sequence = makeJournalSequence("1");
            expect(sequence instanceof Error).toBe(false);
            const key = makeJournalRecordKey(author, sequence);
            expect(key instanceof Error).toBe(false);

            const journal = database.replicaJournalSublevel(replica);
            await journal.put(key, stringToJournalText("{}"));

            const source = await readJournalSource(journal);
            expect(source instanceof Error).toBe(true);
        } finally {
            await database.close();
        }
    });
});
