/**
 * A measurement of the graph commit seam's publication window.
 *
 * `$id-2048186621237391` requires a graph transition and its journal records to become
 * durable as one atomic publication. This suite measures the seam as it stands, over
 * the production path (`createIncrementalGraph` then `pull`), so the window between
 * the two sides of such a transition is a measured quantity rather than an argument
 * from reading the code:
 *
 * - how many durable writes one user-visible operation issues;
 * - which sublevels each of those writes carries; and
 * - what the journal sublevel of the recovered database holds afterwards.
 *
 * The numbers are the ones the pinning suite `journal_atomicity_requirement.test.js`
 * is measured against, and they are what a publication which emits the journal
 * inside the same batch as the graph mutations must change.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const { readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");

const allEventsModule = require("../src/generators/individual/all_events/wrapper");
const metaEventsComputor = require("../src/generators/individual/meta_events/wrapper").computor;
const eventContextComputor = require("../src/generators/individual/event_context/wrapper").computor;

const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");

const CREATOR = {
    name: "tester",
    uuid: "0f6c1a1e-0000-4000-8000-000000000000",
    version: "1.0.0",
    hostname: "host.example",
};

/**
 * Record every batch the schema storage issues, and which sublevel each operation of
 * a batch targets. The sublevel of an operation is recoverable from the operation
 * itself: the schema storage builds one sublevel per name and each operation carries
 * the sublevel it would write.
 * @param {object} db
 * @returns {Array<Array<string>>} one entry per issued batch, naming the sublevels it carried
 */
function instrumentBatches(db) {
    /** @type {Array<Array<string>>} */
    const issued = [];
    const schemaStorage = db.getSchemaStorage();
    const original = schemaStorage.batch;
    schemaStorage.batch = async (operations) => {
        issued.push(operations.map((operation) => sublevelNameOf(schemaStorage, operation.sublevel)));
        return await original(operations);
    };
    return issued;
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
 * @returns {object}
 */
function testCapabilities() {
    fs.mkdtempSync(path.join(os.tmpdir(), "journal-window-"));
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return capabilities;
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
    ];
    const allEventsComputor = allEventsModule.makeComputor(box, {});
    return await createIncrementalGraph(capabilities, db, [
        {
            output: "all_events",
            inputs: [],
            computor: allEventsComputor,
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

describe("the publication window one user-visible operation leaves open", () => {
    test("a three-node pull issues one durable write per node and no journal write at all", async () => {
        const capabilities = testCapabilities();
        const db = await getRootDatabase(capabilities);
        const graph = await makeRealGraph(capabilities, db);
        const issued = instrumentBatches(db);

        await graph.pull("event_context");

        // Measured: one user-visible operation, three materialized nodes, three
        // durable writes. The window between them is two writes wide, and each of
        // them is a point at which the graph side of the operation is durable while
        // the operation as a whole has not finished.
        expect(issued.length).toBe(3);
        for (const batch of issued) {
            expect(batch).toContain("values");
            expect(batch).not.toContain("journal");
        }

        // Measured: nothing at all describes those three graph transitions in the
        // journal, so every one of them is a graph transition whose journal side does
        // not exist.
        const replica = await readRetainedJournal(db.getSchemaStorage().journal);
        expect(replica).not.toBeInstanceOf(Error);
        expect([...replica.values()].flat()).toHaveLength(0);

        await db.close();
    });

    test("a pull which changes no persisted state issues no durable write", async () => {
        const capabilities = testCapabilities();
        const db = await getRootDatabase(capabilities);
        const graph = await makeRealGraph(capabilities, db);
        await graph.pull("event_context");
        const issued = instrumentBatches(db);

        await graph.pull("event_context");

        expect(issued).toHaveLength(0);
        await db.close();
    });
});
