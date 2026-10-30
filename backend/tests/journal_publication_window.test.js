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

const {
    getRootDatabase,
    makeRealGraph,
} = require("../src/generators/incremental_graph/database");
const { readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");
const { isInvalidateEvent } = require("../src/generators/incremental_graph/journal");

const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");

function testCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const logger = stubLogger(capabilities);
    const environment = stubEnvironment(capabilities);
    environment.rootDirectory = async () => "/tmp";
    capabilities.logger = logger;
    capabilities.environment = environment;
    return capabilities;
}

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
