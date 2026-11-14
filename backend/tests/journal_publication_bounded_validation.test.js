"use strict";

/**
 * Ordinary local publication validates only its new batch/projection delta.
 *
 * `incremental-graph-journal-testing.md` §Change-bounded historical validation
 * tests requires:
 *
 * > ordinary local publication validates only its new batch/projection delta and
 * > must not request unrelated retained history;
 *
 * and `incremental-graph-journal-checklist.md` §13 states the same with an O(1)
 * historical-validation overhead in retained history H.
 *
 * The journal store maintains a change-bounded proof summary, and the ordinary
 * publication folds only its own new records into it. This suite pins that the
 * production `pull`/`update` front actually takes that path: a database with a
 * large retained history is built, the journal sublevel is instrumented so that
 * reading a retained record or iterating the sublevel fails the test, and a real
 * production update is performed. The update succeeds only if the publication
 * reads the constant-size committed writer state and the maintained summary,
 * never the retained history.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { makeInterface } = require("../src/generators/interface");
const { readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");
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
    fs.mkdtempSync(path.join(os.tmpdir(), "journal-publication-bounded-"));
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
 * Instrument the journal database so that any history-proportional I/O fails the
 * test. The journal sublevel layout is:
 * - `state` — committed-pair metadata (O(1), allowed)
 * - `retained_state` — the change-bounded proof summary (O(1), allowed)
 * - `occurrence|<digest>` — current occurrence (O(1) per node, allowed)
 * - `record|<author>|<padded coordinate>` — retained records (O(H), forbidden)
 *
 * The proxy keeps every other method (in particular `putOp`, which the publication
 * uses to stage its own new records) delegated to the real database, so the
 * guarded publication still writes exactly as it would unguarded.
 *
 * @param {object} journalDatabase
 * @returns {{instrumented: object, calls: Array<string>}}
 */
function instrumentJournalDatabase(journalDatabase) {
    /** @type {Array<string>} */
    const calls = [];

    const originalGet = journalDatabase.get.bind(journalDatabase);
    const originalKeys = journalDatabase.keys.bind(journalDatabase);

    const instrumented = new Proxy(journalDatabase, {
        get(target, property, receiver) {
            if (property === "get") {
                return async (key) => {
                    const keyText = typeof key === "string" ? key : String(key);
                    if (keyText.startsWith("record|")) {
                        calls.push("get:" + keyText);
                        throw new Error(
                            "ordinary publication must not read retained journal records: " +
                                keyText
                        );
                    }
                    return originalGet(key);
                };
            }
            if (property === "keys") {
                return async function* () {
                    const iterator = originalKeys();
                    const first = await iterator.next();
                    if (!first.done) {
                        yield first.value;
                    }
                    const second = await iterator.next();
                    if (!second.done) {
                        calls.push("keys:full-iteration");
                        throw new Error(
                            "ordinary publication must not iterate the retained journal sublevel"
                        );
                    }
                };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });

    return { instrumented, calls };
}

/**
 * @param {string} idText
 * @param {string} original
 * @returns {object}
 */
function eventOf(idText, original) {
    return {
        id: eventId.fromString(idText),
        date: fromISOString("2020-03-01T09:00:00.000Z"),
        original,
        input: original,
        creator: CREATOR,
    };
}

/**
 * Build a database with a real retained history, then perform one production
 * update while the journal sublevel is instrumented against history-proportional
 * I/O.
 *
 * @param {object} capabilities
 * @param {number} extraUpdates - Extra retained updates to build before the guarded update
 * @param {object} newEvent - The event the guarded update adds
 * @returns {Promise<{before: number, after: number, calls: Array<string>}>}
 */
async function buildAndPublish(capabilities, extraUpdates, newEvent) {
    const first = makeInterface(() => capabilities);
    await first.ensureInitialized();
    await first._requireInitializedGraph().pull("all_events");

    for (let i = 0; i < extraUpdates; i += 1) {
        await first.update([eventOf("aaaaaaaaa:" + (100 + i), "extra event " + i)]);
    }

    const before = await retainedRecordCount(first._database);
    const storage = first._database.getSchemaStorage();
    const original = storage.journal;
    const { instrumented, calls } = instrumentJournalDatabase(original);
    storage.journal = instrumented;

    await first.update([newEvent]);

    storage.journal = original;
    const after = await retainedRecordCount(first._database);
    await first._database.close();

    return { before, after, calls };
}

describe("ordinary local publication validates only its new batch", () => {
    test("a real production update reads no unrelated retained history", async () => {
        const capabilities = testCapabilities();
        stubDatetime(capabilities);

        const { before, after, calls } = await buildAndPublish(
            capabilities,
            20,
            eventOf("bbbbbbbbb:1", "the update under instrumentation")
        );

        // The update really did author records, so the guarded path is exercised.
        expect(before).toBeGreaterThan(0);
        expect(after).toBeGreaterThan(before);
        expect(calls).toEqual([]);
    });

    test("the publication read shape is independent of retained history length H", async () => {
        const capabilities = testCapabilities();
        stubDatetime(capabilities);

        const shallow = await buildAndPublish(
            capabilities,
            0,
            eventOf("ccccccccc:1", "shallow update")
        );
        expect(shallow.calls).toEqual([]);

        const deep = await buildAndPublish(
            capabilities,
            40,
            eventOf("ddddddddd:1", "deep update")
        );

        expect(deep.before).toBeGreaterThan(shallow.before);
        expect(deep.calls).toEqual([]);
    });
});
