/**
 * Routine-open history-independence: the O(1+G) startup bound.
 *
 * `incremental-graph-journal-testing.md` §Routine-open history-independence tests
 * requires that opening an already-current supported database through an
 * instrumented Journal/index storage interface must not request:
 *
 * - full retained-Journal iteration;
 * - per-writer historical range scans beyond constant-size committed head metadata;
 * - history-proportional Journal-index validation; or
 * - replay of retained history.
 *
 * The bound is `$id-7429043816351276`: Journal-specific routine-open work is
 * O(1 + G), independent of retained Journal size H.
 *
 * The instrumentation wraps the journal sublevel so that:
 * - `get("state")` is allowed (committed-pair metadata, O(1));
 * - `get("occurrence|...")` is allowed (current occurrence, O(1) per node);
 * - `get("record|...")` fails (retained record read, O(H));
 * - `keys()` iteration fails (full retained-Journal iteration, O(H)).
 *
 * The test varies H while holding G fixed and asserts the open succeeds
 * without any history-proportional I/O.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { runMigration, runCanonicalBootstrapGate } = require("../src/generators/incremental_graph");
const { readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");
const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { makeInterface } = require("../src/generators/interface");
const { createDefaultGraphDefinition } = require("../src/generators/interface/default_graph");
const { allEvents, config, diarySummary, ontology } = require("../src/generators/individual");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment, stubDatetime, stubRandomSeed, ensureLiveDatabaseDirectory } = require("./stubs");
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
    fs.mkdtempSync(path.join(os.tmpdir(), "journal-routine-open-"));
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubRandomSeed(capabilities);
    ensureLiveDatabaseDirectory(capabilities);
    stubIncrementalDatabaseRemote(capabilities);
    return capabilities;
}

/**
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
 * Instrument the journal sublevel so that history-proportional I/O fails the test.
 *
 * The journal sublevel layout is:
 * - `state` — committed-pair metadata (O(1), allowed)
 * - `record|<author>|<padded coordinate>` — retained records (O(H), forbidden)
 * - `occurrence|<canonical node key>` — current occurrence (O(1) per node, allowed)
 *
 * @param {object} journalSublevel - The journal sublevel to instrument
 * @returns {{instrumented: object, historyProportionalCalls: () => Array<string>}}
 */
function instrumentJournalSublevel(journalSublevel) {
    /** @type {Array<string>} */
    const historyProportionalCalls = [];

    const originalGet = journalSublevel.get.bind(journalSublevel);
    const originalKeys = journalSublevel.keys.bind(journalSublevel);

    const instrumented = {
        get: async (key) => {
            const keyText = typeof key === "string" ? key : String(key);
            if (keyText.startsWith("record|")) {
                historyProportionalCalls.push("get:" + keyText);
                throw new Error(
                    "routine open must not read retained journal records: " + keyText
                );
            }
            return originalGet(key);
        },
        keys: async function* () {
            const iterator = originalKeys();
            const first = await iterator.next();
            if (!first.done) {
                yield first.value;
            }
            const second = await iterator.next();
            if (!second.done) {
                historyProportionalCalls.push("keys:full-iteration");
                throw new Error(
                    "routine open must not iterate the retained journal sublevel beyond the first key"
                );
            }
        },
    };

    return {
        instrumented,
        historyProportionalCalls: () => historyProportionalCalls,
    };
}

/**
 * Build a database with a real graph and the given number of extra pulls, then
 * close it and return the retained record count.
 *
 * @param {object} capabilities
 * @param {number} extraPulls
 * @returns {Promise<number>}
 */
async function buildDatabase(capabilities, extraPulls) {
    const first = makeInterface(() => capabilities);
    await first.ensureInitialized();
    await first._requireInitializedGraph().pull("all_events");

    for (let i = 0; i < extraPulls; i += 1) {
        await first.update([
            {
                id: eventId.fromString("aaaaaaaaa:" + (100 + i)),
                date: fromISOString("2020-03-01T09:00:00.000Z"),
                original: "extra event " + i,
                input: "extra event " + i,
                creator: CREATOR,
            },
        ]);
    }

    const recordCount = await retainedRecordCount(first._database);
    await first._database.close();
    return recordCount;
}

/**
 * Run the routine-open gates (migration gate + canonical bootstrap gate) over a
 * freshly opened database with an instrumented journal sublevel.
 *
 * @param {object} capabilities
 * @returns {Promise<{historyProportionalCalls: Array<string>}>}
 */
async function routineOpenWithInstrumentation(capabilities) {
    const db = await getRootDatabase(capabilities);
    const storage = db.getSchemaStorage();
    const { instrumented, historyProportionalCalls } = instrumentJournalSublevel(storage.journal);
    storage.journal = instrumented;

    const configBox = config.makeBox();
    const allEventsBox = allEvents.makeBox();
    const diarySummaryBox = diarySummary.makeBox();
    const ontologyBox = ontology.makeBox();
    const nodeDefs = createDefaultGraphDefinition(
        capabilities,
        configBox,
        allEventsBox,
        diarySummaryBox,
        ontologyBox
    );

    await runMigration(capabilities, db, nodeDefs, async () => {});
    await runCanonicalBootstrapGate({
        rootDatabase: db,
        nodeDefs,
    });

    const calls = historyProportionalCalls();
    await db.close();
    return { historyProportionalCalls: calls };
}

describe("Journal 3 routine-open history-independence", () => {
    test("routine open of an already-current database performs no history-proportional I/O", async () => {
        const capabilities = testCapabilities();
        stubDatetime(capabilities);

        const recordCount = await buildDatabase(capabilities, 0);
        const result = await routineOpenWithInstrumentation(capabilities);

        expect(recordCount).toBeGreaterThan(0);
        expect(result.historyProportionalCalls).toEqual([]);
    });

    test("routine open operation count is independent of retained history length H", async () => {
        const capabilities = testCapabilities();
        stubDatetime(capabilities);

        const shallowCount = await buildDatabase(capabilities, 0);
        const shallow = await routineOpenWithInstrumentation(capabilities);

        const deepCount = await buildDatabase(capabilities, 20);
        const deep = await routineOpenWithInstrumentation(capabilities);

        expect(deepCount).toBeGreaterThan(shallowCount);
        expect(shallow.historyProportionalCalls).toEqual([]);
        expect(deep.historyProportionalCalls).toEqual([]);
    });

    test("explicit projection rebuild is permitted to iterate retained history", async () => {
        const capabilities = testCapabilities();
        stubDatetime(capabilities);

        const recordCount = await buildDatabase(capabilities, 0);

        const db = await getRootDatabase(capabilities);
        const storage = db.getSchemaStorage();

        let keysIterated = false;
        const originalJournal = storage.journal;
        const originalKeys = originalJournal.keys.bind(originalJournal);
        storage.journal = {
            get: (key) => originalJournal.get(key),
            keys: async function* () {
                keysIterated = true;
                yield* originalKeys();
            },
        };

        const replica = await readRetainedJournal(storage.journal);
        expect(replica instanceof Error).toBe(false);
        expect(keysIterated).toBe(true);
        expect([...replica.values()].flat().length).toBe(recordCount);

        await db.close();
    });
});
