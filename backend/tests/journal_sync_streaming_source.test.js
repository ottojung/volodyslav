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
    readRetainedJournal,
} = require("../src/generators/incremental_graph/journal_store");
const {
    journalAuthorToString,
    makeJournalAuthor,
    makeJournalSequence,
    makeReplicaSource,
    projectRetainedJournal,
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

/**
 * Count the record-range reads the production synchronization/reset front makes
 * against one replica's raw journal sublevel.
 *
 * The front reaches a source journal through `database.replicaJournalSublevel`, so
 * replacing that method with one which returns a record-range-counting sublevel for
 * exactly the named replica observes every read the front makes against it without
 * touching the other replica or the fixture's own rendering. The first sublevel the
 * method returns for that replica is the one wrapped, and it is returned for every
 * later call as well, so a front which reads the source through several handles still
 * accumulates into one count.
 *
 * @param {object} database
 * @param {string} source - The replica name whose raw journal sublevel to count.
 * @returns {() => {rangesOpened: number, entriesYielded: number}}
 */
function countSourceRecordRanges(database, source) {
    const original = database.replicaJournalSublevel.bind(database);
    /** @type {object | undefined} */
    let wrapped;
    /** @type {{rangesOpened: number, entriesYielded: number} | undefined} */
    let stats;
    database.replicaJournalSublevel = (name) => {
        const sublevel = original(name);
        if (name !== source) {
            return sublevel;
        }
        if (wrapped === undefined) {
            wrapped = sublevel;
            stats = countJournalRecordRanges(sublevel);
        }
        return wrapped;
    };
    return () => stats ?? { rangesOpened: 0, entriesYielded: 0 };
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

    test("synchronization derives the observed high-water from committed metadata, not a source-history scan", async () => {
        const capabilities = testCapabilities();
        const { database, receiver, source } = await buildReceiverWithHeldSnapshot(capabilities);
        const sourceRanges = countSourceRecordRanges(database, source);
        try {
            const changed = await syncJournalReceiverToSource({
                database,
                capabilities,
                receiver,
                source,
            });

            expect(changed).toBe(true);
            // The source and receiver share one writer here, so there is no foreign
            // suffix to import and no forward record range to open. The observed
            // high-water comes from the source's committed metadata, so the retained
            // history is never re-read to re-derive a value the source already
            // persists. A front which scanned the source would yield one entry per
            // retained record here.
            const stats = sourceRanges();
            expect(stats.rangesOpened).toBe(0);
            expect(stats.entriesYielded).toBe(0);
        } finally {
            await database.close();
        }
    });

    test("reset derives the observed high-water from committed metadata, not a source-history scan", async () => {
        const capabilities = testCapabilities();
        const { database, receiver, source } = await buildReceiverWithHeldSnapshot(capabilities);
        const sourceRanges = countSourceRecordRanges(database, source);
        try {
            const changed = await resetJournalReceiverToSnapshot({
                database,
                capabilities,
                receiver,
                source,
            });

            expect(changed).toBe(true);
            const stats = sourceRanges();
            expect(stats.rangesOpened).toBe(0);
            expect(stats.entriesYielded).toBe(0);
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
            // A streaming source reads one record at a time, so it cannot report a
            // stored record it cannot decode before it is asked for one. The
            // corruption is rejected through the reader's own failure channel when
            // the source is consumed, which is where every production front reads it.
            expect(source instanceof Error).toBe(false);
            if (source instanceof Error) {
                return;
            }
            let failure;
            for (const writer of source.writers()) {
                const reader = source.prefixReaderOf(writer);
                for (;;) {
                    const record = await reader.nextRecord();
                    if (record === undefined) {
                        break;
                    }
                }
                if (reader.failure() !== undefined) {
                    failure = reader.failure();
                    break;
                }
            }
            expect(failure).toBeDefined();
        } finally {
            await database.close();
        }
    });
});

/**
 * Count the record-range iterators a sublevel is asked for and the entries they
 * yield, so a test can tell a materialising read from a streaming one.
 *
 * A writer's retained length is one reverse range read with `limit: 1` and the
 * writer discovery is a `keys()` scan; neither is a record-range read. A reader
 * over a writer's retained records opens the writer's own forward range
 * (`gte`/`lte`), and the streaming source pulls its entries one at a time.
 *
 * @param {object} journal
 * @returns {{rangesOpened: number, entriesYielded: number}}
 */
function countJournalRecordRanges(journal) {
    const stats = { rangesOpened: 0, entriesYielded: 0 };
    const original = journal.iterator.bind(journal);
    journal.iterator = (options = {}) => {
        const isRecordRange =
            options.gte !== undefined && options.lte !== undefined && options.reverse !== true;
        if (!isRecordRange) {
            return original(options);
        }
        stats.rangesOpened += 1;
        const inner = original(options)[Symbol.asyncIterator]();
        return {
            [Symbol.asyncIterator]() {
                return this;
            },
            async next() {
                const step = await inner.next();
                if (step.done !== true) {
                    stats.entriesYielded += 1;
                }
                return step;
            },
            async return(...args) {
                if (typeof inner.return === "function") {
                    return inner.return(...args);
                }
                return { done: true, value: undefined };
            },
        };
    };
    return stats;
}

/**
 * Wrap a `JournalSource` so a test can observe how many of its writers the oracle
 * has open at once, how many readers it asked for, and how many records it read.
 *
 * @param {object} source
 * @returns {object}
 */
function openReaderCountingSource(source) {
    let open = 0;
    let maxOpen = 0;
    let readers = 0;
    let reads = 0;
    return {
        writers: () => source.writers(),
        retainedLengthOf: (author) => source.retainedLengthOf(author),
        prefixReaderOf: (author) => {
            readers += 1;
            open += 1;
            maxOpen = Math.max(maxOpen, open);
            const reader = source.prefixReaderOf(author);
            let closed = false;
            const close = () => {
                if (!closed) {
                    closed = true;
                    open -= 1;
                }
            };
            return {
                nextRecord: async () => {
                    const record = await reader.nextRecord();
                    reads += 1;
                    if (record === undefined) {
                        close();
                    }
                    return record;
                },
                failure: () => {
                    close();
                    return reader.failure();
                },
            };
        },
        stats: () => ({ maxOpen, readers, reads }),
    };
}

describe("the streaming source materialises no retained history", () => {
    test("readJournalSource opens no writer's record range before the oracle reads", async () => {
        const capabilities = testCapabilities();
        const database = await getRootDatabase(capabilities);
        try {
            const graph = await makeRealGraph(capabilities, database, "the receiver wrote this");
            await graph.pull("event_context");

            const replica = database.currentReplicaName();
            const journal = database.replicaJournalSublevel(replica);
            const stats = countJournalRecordRanges(journal);

            const source = await readJournalSource(journal);
            expect(source instanceof Error).toBe(false);
            expect(stats.rangesOpened).toBe(0);
            expect(stats.entriesYielded).toBe(0);
        } finally {
            await database.close();
        }
    });

    test("a reader pulls one stored record at a time rather than the whole prefix", async () => {
        const capabilities = testCapabilities();
        const database = await getRootDatabase(capabilities);
        try {
            const graph = await makeRealGraph(capabilities, database, "the receiver wrote this");
            await graph.pull("event_context");

            const replica = database.currentReplicaName();
            const storage = database.schemaStorageForReplica(replica);
            const journal = database.replicaJournalSublevel(replica);
            const author = makeJournalAuthor(database.getFingerprint());
            expect(author instanceof Error).toBe(false);

            const retained = await readRetainedJournal(storage.journal);
            const writerName = journalAuthorToString(author);
            const writerRecords = [...retained].find(
                ([held]) => journalAuthorToString(held) === writerName
            );
            expect(writerRecords).toBeDefined();
            const total = writerRecords === undefined ? 0 : writerRecords[1].length;
            expect(total).toBeGreaterThan(1);

            const stats = countJournalRecordRanges(journal);
            const source = await readJournalSource(journal);
            expect(source instanceof Error).toBe(false);
            if (source instanceof Error) {
                return;
            }
            const reader = source.prefixReaderOf(author);
            const first = await reader.nextRecord();
            expect(first instanceof Error).toBe(false);
            expect(first).toBeDefined();
            // One pulled record is one yielded entry: the reader is not a scan which
            // decodes the whole prefix before returning the first record.
            expect(stats.entriesYielded).toBe(1);
            expect(stats.entriesYielded).toBeLessThan(total);
        } finally {
            await database.close();
        }
    });

    test("the streaming source replays identically to the materialized replica", async () => {
        const capabilities = testCapabilities();
        const database = await getRootDatabase(capabilities);
        try {
            const graph = await makeRealGraph(capabilities, database, "the receiver wrote this");
            await graph.pull("event_context");

            const replica = database.currentReplicaName();
            const storage = database.schemaStorageForReplica(replica);
            const journal = database.replicaJournalSublevel(replica);
            const localWriter = makeJournalAuthor(database.getFingerprint());
            expect(localWriter instanceof Error).toBe(false);

            const streamingSource = await readJournalSource(journal);
            expect(streamingSource instanceof Error).toBe(false);
            if (streamingSource instanceof Error) {
                return;
            }
            const replicaRead = await readRetainedJournal(storage.journal);
            expect(replicaRead instanceof Error).toBe(false);
            if (replicaRead instanceof Error) {
                return;
            }

            const streaming = await projectRetainedJournal({
                source: streamingSource,
                localWriter,
                currentInputKeysOfNode: () => [],
            });
            const materialized = await projectRetainedJournal({
                source: makeReplicaSource(replicaRead),
                localWriter,
                currentInputKeysOfNode: () => [],
            });
            expect(streaming instanceof Error).toBe(false);
            expect(materialized instanceof Error).toBe(false);
            expect(streaming).toEqual(materialized);
        } finally {
            await database.close();
        }
    });

    test("the oracle holds at most one writer's reader open and re-reads per pass", async () => {
        const capabilities = testCapabilities();
        const database = await getRootDatabase(capabilities);
        try {
            const graph = await makeRealGraph(capabilities, database, "the receiver wrote this");
            await graph.pull("event_context");

            const replica = database.currentReplicaName();
            const journal = database.replicaJournalSublevel(replica);
            const localWriter = makeJournalAuthor(database.getFingerprint());
            expect(localWriter instanceof Error).toBe(false);

            const streamingSource = await readJournalSource(journal);
            expect(streamingSource instanceof Error).toBe(false);
            if (streamingSource instanceof Error) {
                return;
            }
            const writers = streamingSource.writers().length;
            expect(writers).toBeGreaterThan(0);
            const counted = openReaderCountingSource(streamingSource);

            const projection = await projectRetainedJournal({
                source: counted,
                localWriter,
                currentInputKeysOfNode: () => [],
            });
            expect(projection instanceof Error).toBe(false);

            const stats = counted.stats();
            // The oracle walks one writer at a time, so it never has the complete
            // retained journal open as one collection.
            expect(stats.maxOpen).toBe(1);
            // It makes several passes and asks for a fresh reader each time, which is
            // exactly the streaming behaviour a materialising source could not offer.
            expect(stats.readers).toBeGreaterThan(writers);
        } finally {
            await database.close();
        }
    });

    test("synchronization publishes the retained records in one atomic batch", async () => {
        const capabilities = testCapabilities();
        const levelOf = interceptLevel(capabilities);
        const { database, receiver, source } = await buildReceiverWithHeldSnapshot(capabilities);
        const level = levelOf();
        /** @type {Array<Array<unknown>>} */
        const batches = [];
        const originalBatch = level.batch.bind(level);
        level.batch = (operations, ...rest) => {
            batches.push(operations);
            return originalBatch(operations, ...rest);
        };
        try {
            const changed = await syncJournalReceiverToSource({
                database,
                capabilities,
                receiver,
                source,
            });

            expect(changed).toBe(true);
            // The retained records are streamed into the same single batch as the
            // outcome's own records, so the target is never observed half-written and
            // the cutover stays one atomic write.
            expect(batches).toHaveLength(1);
            expect(batches[0].length).toBeGreaterThan(0);
        } finally {
            await database.close();
        }
    });
});
