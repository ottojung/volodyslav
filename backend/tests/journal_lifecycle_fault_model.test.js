/**
 * The §13 lifecycle fault model: physical damage of the local persistent store.
 *
 * `database-lifecycle.md` §13 and `incremental-graph-journal-testing.md`
 * §Lifecycle fault-model tests make the supported external-loss case exactly one thing —
 * complete disappearance of the local database, which yields `Absent` and enters the §4
 * decision. Everything else is corrupted/unsupported:
 *
 * - partial deletion of Journal/graph state;
 * - replacement with an older local snapshot (release rollback);
 * - mixed old/new persistent state;
 * - direct external mutation of the store;
 * - an existing but damaged/truncated database, which must never be routed through
 *   absent restoration or silently reinterpreted as fresh.
 *
 * The writer-behind and same-ID-disagreement corruption cases already have dedicated
 * suites (`journal_sync_fork.test.js`, `journal_sync.test.js`, `journal_reset.test.js`);
 * this suite covers the remaining physical-damage cases only.
 *
 * Every test damages the real live LevelDB of a real current Journal database built by
 * the real production path, then reads the damaged state back through the production
 * boundary that is responsible for it. Nothing here mutates an in-memory fixture: the
 * damage is persisted and re-read.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");
const {
    isJournalGapError,
    isJournalSourceReadError,
    isJournalWriterBehindError,
    makeJournalAuthor,
    makeReplicaSource,
    validateJournalReplica,
} = require("../src/generators/incremental_graph/journal");
const { planForeignSuffixImport } = require("../src/generators/incremental_graph/journal_sync");
const { makeInterface } = require("../src/generators/interface");
const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubLogger,
    stubEnvironment,
    stubDatetime,
    stubRandomSeed,
    ensureLiveDatabaseDirectory,
} = require("./stubs");
const { stubIncrementalDatabaseRemote } = require("./stub_incremental_database_remote");

const CREATOR = {
    name: "tester",
    uuid: "0f6c1a1e-0000-4000-8000-000000000000",
    version: "1.0.0",
    hostname: "host.example",
};

/**
 * @returns {object}
 */
function testCapabilities() {
    fs.mkdtempSync(path.join(os.tmpdir(), "journal-fault-model-"));
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    stubRandomSeed(capabilities);
    ensureLiveDatabaseDirectory(capabilities);
    stubIncrementalDatabaseRemote(capabilities);
    return capabilities;
}

/**
 * Build a real, current Journal database through the production interface, so the state
 * the suite damages is state the production path produced. Returns the observable events
 * the graph persisted, so a later assertion can compare against them.
 * @param {object} capabilities
 * @returns {Promise<Array<object>>}
 */
async function buildLiveJournal(capabilities) {
    const interfaceInstance = makeInterface(() => capabilities);
    await interfaceInstance.ensureInitialized();
    await interfaceInstance._requireInitializedGraph().pull("all_events");
    await interfaceInstance.update([
        {
            id: eventId.fromString("aaaaaaaaa:100"),
            date: fromISOString("2020-03-01T09:00:00.000Z"),
            original: "extra event 0",
            input: "extra event 0",
            creator: CREATOR,
        },
    ]);
    await interfaceInstance.update([
        {
            id: eventId.fromString("aaaaaaaaa:101"),
            date: fromISOString("2020-03-02T09:00:00.000Z"),
            original: "extra event 1",
            input: "extra event 1",
            creator: CREATOR,
        },
    ]);
    const events = await interfaceInstance.getAllEvents();
    await interfaceInstance._database.close();
    return events;
}

/**
 * Every raw key/value pair in the live LevelDB, through the raw accessor that bypasses
 * the sublevel abstraction. This is what lets a test act as an external writer.
 * @param {object} capabilities
 * @returns {Promise<{db: object, entries: Array<[string, unknown]>}>}
 */
async function rawLiveDatabase(capabilities) {
    const db = await getRootDatabase(capabilities);
    /** @type {Array<[string, unknown]>} */
    const entries = [];
    for await (const [key, value] of db._rawEntries()) {
        entries.push([key, value]);
    }
    return { db, entries };
}

/**
 * The raw keys of the retained journal records, in writer-stream order.
 * @param {Array<[string, unknown]>} entries
 * @returns {Array<string>}
 */
function journalRecordKeys(entries) {
    return entries
        .map(([key]) => key)
        .filter((key) => key.includes("!journal!record|"))
        .sort();
}

/**
 * @param {Array<[string, unknown]>} entries
 * @returns {string}
 */
function stateKey(entries) {
    const entry = entries.find(([key]) => key.endsWith("!journal!state"));
    if (entry === undefined) {
        throw new Error("the fixture database has no journal state record");
    }
    return entry[0];
}

/**
 * @param {Array<[string, unknown]>} entries
 * @param {string} suffix
 * @returns {string}
 */
function globalKey(entries, suffix) {
    const entry = entries.find(([key]) => key.endsWith("!global!" + suffix));
    if (entry === undefined) {
        throw new Error("the fixture database has no global/" + suffix);
    }
    return entry[0];
}

/**
 * Read the retained replica of a live database.
 * @param {object} capabilities
 * @returns {Promise<{replica: object, localWriter: string}>}
 */
async function readLiveReplica(capabilities) {
    const db = await getRootDatabase(capabilities);
    try {
        const replica = await readRetainedJournal(db.getSchemaStorage().journal);
        if (replica instanceof Error) {
            throw replica;
        }
        return { replica, localWriter: db.getFingerprint() };
    } finally {
        await db.close();
    }
}

/**
 * The writer a replica retains, which is the fixture's own local writer.
 * @param {object} replica
 * @returns {string}
 */
function soleWriterOf(replica) {
    const writers = [...replica.keys()];
    if (writers.length !== 1) {
        throw new Error("the fixture replica should retain exactly one writer");
    }
    return writers[0].__value;
}

describe("Journal 3 §7 lifecycle fault model: physical damage of the local store", () => {
    test("(a) partial deletion of a retained record is reported as a hole, not normalized into a shorter history", async () => {
        const capabilities = testCapabilities();
        await buildLiveJournal(capabilities);

        const { db, entries } = await rawLiveDatabase(capabilities);
        const records = journalRecordKeys(entries);
        expect(records.length).toBeGreaterThanOrEqual(6);
        // Delete one record in the middle of the local writer's stream, leaving both
        // its predecessor and its successor retained. A shorter prefix would still be
        // internally usable, but this is a durable hole.
        await db._rawDel(records[4]);
        const committed = JSON.parse(String(entries.find(([key]) => key === stateKey(entries))[1]));
        await db.close();

        const { replica } = await readLiveReplica(capabilities);
        const malformed = validateJournalReplica(replica);
        expect(isJournalGapError(malformed)).toBe(true);
        // The committed-pair metadata still claims the longer prefix, so the missing
        // coordinate is not a legitimate shorter history: it is evidence of loss.
        expect(Number(committed.writerHead)).toBeGreaterThan(replica.get(
            makeJournalAuthor(soleWriterOf(replica))
        ).length);
    });

    test("(b) rollback to an older local snapshot is rejected as writer-behind and never repaired by importing the surviving suffix", async () => {
        const capabilities = testCapabilities();
        await buildLiveJournal(capabilities);

        const { replica: surviving, localWriter } = await readLiveReplica(capabilities);
        const survivingLength = surviving.get(makeJournalAuthor(localWriter)).length;
        expect(survivingLength).toBeGreaterThanOrEqual(6);

        // Physically roll the live database back to an older coherent snapshot: drop
        // every record above coordinate K and roll the committed-pair metadata back to
        // the same head, so the receiver is a valid older database that lost a suffix.
        const rollbackTo = 3;
        const { db, entries } = await rawLiveDatabase(capabilities);
        for (const key of journalRecordKeys(entries)) {
            const coordinate = Number(key.slice(key.lastIndexOf("|") + 1));
            if (coordinate > rollbackTo) {
                await db._rawDel(key);
            }
        }
        const state = JSON.parse(String(entries.find(([key]) => key === stateKey(entries))[1]));
        await db._rawPut(stateKey(entries), JSON.stringify({
            ...state,
            writerHead: String(rollbackTo),
            committedFrontier: [[localWriter, String(rollbackTo)]],
        }));
        await db.close();

        const { replica: rolledBack } = await readLiveReplica(capabilities);
        expect(rolledBack.get(makeJournalAuthor(localWriter)).length).toBe(rollbackTo);

        // The surviving supported history is ahead for the receiver's own writer. The
        // production import plan must refuse before admitting any record, because this
        // is the unsupported rollback state, not a longer peer prefix.
        const result = await planForeignSuffixImport({
            receiver: makeReplicaSource(rolledBack),
            source: makeReplicaSource(surviving),
            localWriter: makeJournalAuthor(localWriter),
            currentInputKeysOfNode: () => [],
        });
        expect("suffixes" in result).toBe(false);
        if ("suffixes" in result) {
            return;
        }
        expect(isJournalWriterBehindError(result.error)).toBe(true);
        expect(result.error.localWriter).toBe(localWriter);

        // And the refusal is not a repair: the receiver still retains only the older
        // prefix afterwards.
        const { replica: after } = await readLiveReplica(capabilities);
        expect(after.get(makeJournalAuthor(localWriter)).length).toBe(rollbackTo);
    });

    test("(c) mixed old/new persistent state is rejected rather than assembled", async () => {
        const capabilities = testCapabilities();
        await buildLiveJournal(capabilities);

        // Mix a record that belongs to the local writer into a different writer's
        // directory, which is what copying files between two database moments leaves
        // behind. The key names one writer while the record names another.
        const { db, entries } = await rawLiveDatabase(capabilities);
        const firstKey = journalRecordKeys(entries)[0];
        const foreignKey = firstKey.replace(/record\|[^|]+\|/, "record|zzzzzzzzz|");
        await db._rawPut(foreignKey, String(entries.find(([key]) => key === firstKey)[1]));
        await db.close();

        const db2 = await getRootDatabase(capabilities);
        const replica = await readRetainedJournal(db2.getSchemaStorage().journal);
        await db2.close();

        expect(replica).toBeInstanceOf(Error);
        if (!(replica instanceof Error)) {
            return;
        }
        expect(isJournalSourceReadError(replica)).toBe(true);
        expect(replica.message).toMatch(/another writer/);
    });

    test("(d) direct external mutation of a stored record is rejected", async () => {
        const capabilities = testCapabilities();
        await buildLiveJournal(capabilities);

        // Rewrite one record's canonical text so the identity it states no longer
        // matches the coordinate it is stored under. This is exactly the shape an
        // external writer which does not go through the store leaves behind.
        const { db, entries } = await rawLiveDatabase(capabilities);
        const recordKey = journalRecordKeys(entries)[4];
        const text = String(entries.find(([key]) => key === recordKey)[1]);
        const mutated = text.replace(/"id":"([^"]+):(\d+)"/, (_match, author) => `"id":"${author}:999"`);
        expect(mutated).not.toBe(text);
        await db._rawPut(recordKey, mutated);
        await db.close();

        const db2 = await getRootDatabase(capabilities);
        const replica = await readRetainedJournal(db2.getSchemaStorage().journal);
        await db2.close();

        expect(replica).toBeInstanceOf(Error);
        if (!(replica instanceof Error)) {
            return;
        }
        expect(isJournalSourceReadError(replica)).toBe(true);
        expect(replica.message).toMatch(/disagrees with the record it stores/);
    });

    test("(e) an existing but damaged/truncated database is not routed through absent restore", async () => {
        const capabilities = testCapabilities();
        const eventsBefore = await buildLiveJournal(capabilities);
        expect(eventsBefore.length).toBeGreaterThan(0);

        const { db, entries } = await rawLiveDatabase(capabilities);
        // Partially delete the database's format-selecting metadata while the directory and
        // the structured graph/journal state remain. The directory still exists, so this is
        // an existing damaged database rather than complete disappearance.
        await db._rawDel(globalKey(entries, "version"));
        await db._rawDel(globalKey(entries, "graph_scheme"));
        await db.close();

        const second = makeInterface(() => capabilities);
        // An existing local database is never routed through the absent-state decision:
        // the directory exists. Partial deletion of
        // the format-selecting metadata is corrupted/unsupported state, so startup fails
        // closed rather than re-initializing the existing replica as fresh.
        await expect(second.ensureInitialized()).rejects.toThrow(
            /refusing to re-initialize an existing replica as fresh/
        );
    });
});
