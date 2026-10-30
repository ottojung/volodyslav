/**
 * The publication-window requirement, pinned as a test.
 *
 * `$id-2048186621237391` requires that whenever one supported operation changes
 * IncrementalGraph sublevels and appends corresponding journal history, those
 * changes become durable as ONE atomic publication. This suite asserts the shape
 * of that publication from outside the record layer: the production path must
 * issue exactly one batched write to the journal store for such a transition, and
 * that batch must carry both the graph-side freshness/validity markers and the
 * journal-side effect.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
    getRootDatabase,
    makeRealGraph,
} = require("../src/generators/incremental_graph/database");
const { readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");
const { isInvalidateEvent } = require("../src/generators/incremental_graph/journal");

const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");

function testCapabilities() {
    fs.mkdtempSync(path.join(os.tmpdir(), "journal-window-"));
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return capabilities;
}

/**
 * @param {object} schemaStorage
 * @param {unknown} sublevel
 * @returns {string}
 */
function sublevelNameOf(schemaStorage, sublevel) {
    for (const name of ["values", "freshness", "valid", "timestamps", "global", "journal"]) {
        if (schemaStorage[name] !== undefined && schemaStorage[name].sublevel === sublevel) {
            return name;
        }
    }
    return "unknown";
}

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
            original: "today I ate a sandwich",
            input: "today I ate a sandwich",
            creator: CREATOR,
        },
        {
            id: eventId.fromString("aaaaaaaaa:2"),
            date: fromISOString("2020-01-01T10:00:00.000Z"),
            original: "the sky is blue",
            input: "the sky is blue",
            creator: CREATOR,
        },
    ];
    const graph = await createIncrementalGraph(capabilities, db, box);
    await graph.pull("all_events");
    return graph;
}

const allEventsModule = require("../src/generators/individual/all_events/wrapper");
const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");

const CREATOR = {
    name: "tester",
    uuid: "0f6c1a1e-0000-4000-8000-000000000000",
    version: "1.0.0",
    hostname: "host.example",
};

function instrumentBatches(db) {
    const schemaStorage = db.getSchemaStorage();
    const journalStorage = schemaStorage.journal;
    const originalBatch = journalStorage.batch.bind(journalStorage);
    /** @type {string[]} */
    const issued = [];
    journalStorage.batch = async (/** @type {string[]} */ operations) => {
        issued.push(operations.join("\n"));
        return originalBatch(operations);
    };
    return issued;
}

describe("Journal publication window", () => {
    test("a pull that advances freshness publishes graph and journal effects in one durable write", async () => {
        const capabilities = testCapabilities();
        const db = await getRootDatabase(capabilities);
        const graph = await makeRealGraph(capabilities, db);
        await graph.pull("event_context");
        const issued = instrumentBatches(db);

        await graph.pull("meta_events");

        expect(issued).toHaveLength(1);
        expect(issued[0]).toContain("freshness");
        expect(issued[0]).toContain("valid");
        expect(issued[0]).toContain("journal");

        await db.close();
    });

    test("a pull with no advancement issues no journal publication", async () => {
        const capabilities = testCapabilities();
        const db = await getRootDatabase(capabilities);
        const graph = await makeRealGraph(capabilities, db);
        await graph.pull("event_context");
        const issued = instrumentBatches(db);

        await graph.pull("event_context");

        expect(issued).toHaveLength(0);
        await db.close();
    });

    test("an explicit invalidation publishes its graph and journal effects in one durable write", async () => {
        const capabilities = testCapabilities();
        const db = await getRootDatabase(capabilities);
        const graph = await makeRealGraph(capabilities, db);
        await graph.pull("event_context");
        const issued = instrumentBatches(db);

        await graph.invalidate("meta_events");

        expect(issued).toHaveLength(1);
        expect(issued[0]).toContain("freshness");
        expect(issued[0]).toContain("valid");
        expect(issued[0]).toContain("journal");

        const replica = await readRetainedJournal(db.getSchemaStorage().journal);
        expect(replica).not.toBeInstanceOf(Error);
        const records = [...replica.values()].flat();
        expect(records.filter(isInvalidateEvent)).toHaveLength(2);
        const invalidations = records.filter(isInvalidateEvent);
        expect(invalidations.map((record) => record.scope.kind)).toEqual(["node", "value"]);
        expect(invalidations.every((record) => record.reason === "explicit" || record.reason === "propagated")).toBe(true);

        await db.close();
    });
});
