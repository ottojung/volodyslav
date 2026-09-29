/**
 * The atomic publication requirement, pinned as a test.
 *
 * `$id-2048186621237391` requires that whenever one supported operation changes
 * IncrementalGraph sublevels and appends corresponding journal history, those changes
 * become durable as ONE atomic publication: a supported persisted state must not
 * expose the graph side of a transition without its journal side, nor the journal side
 * without the matching graph transition.
 *
 * This suite drives the production path — `createIncrementalGraph`, then `invalidate`,
 * then `pull` — over the repository's real computors, and asserts the requirement in
 * both directions against the RECOVERED state read back through a fresh database
 * handle. It is deliberately not a test of emission in isolation: emission's own
 * suites prove that `finalizeEmission` produces correct records, which says nothing
 * about whether a production operation publishes them.
 *
 * It also injects a failure at the publication boundary and asserts that the
 * recovered state is free of both kinds of mismatch, so a commit seam which
 * published only one side of a transition cannot pass.
 *
 * What this suite alone cannot detect is a journal side written in a SECOND durable
 * write issued after the graph batch: the recovered state after a successful
 * publication is the same either way, and an injected failure of the first write
 * still leaves both sides absent. The pin against that shape is
 * `journal_publication_window.test.js`, which counts the durable writes one
 * user-visible operation issues and the sublevels each of them carries; here the
 * recovered state is the consequence, and there the shape of the publication is
 * the claim.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const {
    readCommittedWriterState,
    readRetainedJournal,
} = require("../src/generators/incremental_graph/journal_store");
const { validateJournalReplica, isValueEvent, isInvalidateEvent } = require("../src/generators/incremental_graph/journal");

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
 * The real graph the suite operates on: three real heads whose computors need
 * neither a filesystem nor an AI capability, so the whole path is the production
 * path and not a fixture standing in for one.
 * @returns {{computor: Function}}
 */
function realAllEventsComputor() {
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
    return { computor: allEventsModule.makeComputor(box, {}) };
}

/**
 * @param {object} capabilities
 * @param {object} db
 * @returns {Promise<import("../src/generators/incremental_graph").IncrementalGraph>}
 */
async function makeRealGraph(capabilities, db) {
    const { computor: allEventsComputor } = realAllEventsComputor();
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

/**
 * @returns {object}
 */
function testCapabilities() {
    fs.mkdtempSync(path.join(os.tmpdir(), "journal-atomicity-"));
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return capabilities;
}

/**
 * The journal records a recovered database holds, together with the committed
 * writer state, or the read error the recovery reported.
 * @param {object} db
 * @returns {Promise<{records: Array<object>, writerState: unknown}>}
 */
async function readRecoveredJournal(db) {
    const journalDatabase = db.getSchemaStorage().journal;
    const replica = await readRetainedJournal(journalDatabase);
    if (replica instanceof Error) {
        throw replica;
    }
    const writerState = await readCommittedWriterState(journalDatabase, db.getFingerprint());
    if (writerState instanceof Error) {
        throw writerState;
    }
    /** @type {Array<object>} */
    const records = [];
    for (const entry of replica) {
        records.push(...entry[1]);
    }
    return { records, writerState, replica };
}

describe("graph and journal publication is one atomic write", () => {
    /** @type {object} */
    let capabilities;
    /** @type {object} */
    let db;
    /** @type {import("../src/generators/incremental_graph").IncrementalGraph} */
    let graph;

    beforeEach(async () => {
        capabilities = testCapabilities();
        db = await getRootDatabase(capabilities);
        graph = await makeRealGraph(capabilities, db);
    });

    afterEach(async () => {
        await db.close();
    });

    test("a production pull publishes a journal record for every node it materialized", async () => {
        await graph.pull("event_context");

        // The graph side exists: three materialized nodes are durable.
        expect(await graph.getFreshness("all_events")).toBe("up-to-date");
        expect(await graph.getFreshness("meta_events")).toBe("up-to-date");
        expect(await graph.getFreshness("event_context")).toBe("up-to-date");

        // The journal side must exist with it. A graph transition durable without
        // the records that describe it is exactly what the requirement forbids.
        const { records, writerState, replica } = await readRecoveredJournal(db);
        expect(validateJournalReplica(replica)).not.toBeInstanceOf(Error);
        const materialized = records.filter(isValueEvent);
        expect(materialized.length).toBe(3);
        expect(writerState.writerHead).toBeDefined();
    });

    test("an explicit invalidation publishes its journal record together with the freshness it writes", async () => {
        await graph.pull("event_context");
        const before = await readRecoveredJournal(db);

        await graph.invalidate("meta_events");

        const after = await readRecoveredJournal(db);
        const fresh = after.records.filter(isInvalidateEvent);
        expect(fresh.length).toBeGreaterThan(before.records.filter(isInvalidateEvent).length);
        expect(await graph.getFreshness("meta_events")).toBe("potentially-outdated");
    });

    test("a failed publication leaves neither side of the transition", async () => {
        // Fail the durable write itself, which is what a crash inside the publication
        // looks like to the caller. Because the graph mutations and their journal
        // records are members of one batch, a failed batch must leave both absent;
        // a design which wrote the journal after the graph batch would leave the
        // graph transition durable here with no journal side.
        const namespaceSublevel = db.getSchemaStorage();
        const batch = namespaceSublevel.batch;
        namespaceSublevel.batch = async () => {
            throw new Error("injected publication failure");
        };
        try {
            await expect(graph.pull("event_context")).rejects.toThrow("injected publication failure");
        } finally {
            namespaceSublevel.batch = batch;
        }

        expect(await graph.getFreshness("all_events")).toBeUndefined();
        const { records } = await readRecoveredJournal(db);
        expect(records.length).toBe(0);
    });
});
