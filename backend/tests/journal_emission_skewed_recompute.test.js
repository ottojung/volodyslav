/**
 * Ordinary recompute preserves a skewed value timestamp pair.
 *
 * `incremental-graph-journal-testing.md` §Skewed value-timestamp regression
 * requires: materialize K with a persisted `createdAt = Tfuture`, then recompute
 * K on a writer whose current wall clock produces `modifiedAt = Tnow < Tfuture`.
 * The new `ValueEvent` must preserve `createdAt = Tfuture` and carry the exact
 * committed `modifiedAt = Tnow` without rejection or timestamp normalization.
 * Conflict authority remains governed by `AuthorityTime`.
 *
 * Record-level acceptance of a skewed occurrence is pinned by
 * `journal_well_formedness.test.js`; bootstrap preservation is pinned by
 * `journal_bootstrap_skewed_timestamp.test.js`. This suite pins the ordinary
 * production recompute path (`recompute.js` timestamp preservation through
 * `finalizeEmission`): it drives `createIncrementalGraph` and `pull` over the
 * real `all_events` computor with a controlled clock, first at `Tfuture` to
 * materialize, then at `Tnow` with changed input to recompute.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const { readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");
const {
    isValueEvent,
    journalRecordIdToString,
} = require("../src/generators/incremental_graph/journal");

const allEventsModule = require("../src/generators/individual/all_events/wrapper");

const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment, stubDatetime } = require("./stubs");

const CREATOR = {
    name: "tester",
    uuid: "0f6c1a1e-0000-4000-8000-000000000000",
    version: "1.0.0",
    hostname: "host.example",
};

/** The persisted creation instant: the future the first materialization observes. */
const TFUTURE = "2030-06-01T00:00:00.000Z";
/** The wall clock the later recompute observes: strictly before the creation instant. */
const TNOW = "2024-06-01T00:00:00.000Z";

/**
 * @returns {object}
 */
function testCapabilities() {
    fs.mkdtempSync(path.join(os.tmpdir(), "journal-skewed-recompute-"));
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

/**
 * A real graph with only the `all_events` head, exposing the source box so the
 * test can change the computor input between pulls.
 * @param {object} capabilities
 * @param {object} db
 * @returns {Promise<{graph: import("../src/generators/incremental_graph").IncrementalGraph, box: object}>}
 */
async function makeGraph(capabilities, db) {
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
    const graph = await createIncrementalGraph(capabilities, db, [
        {
            output: "all_events",
            inputs: [],
            computor: allEventsModule.makeComputor(box, {}),
            isDeterministic: false,
            hasSideEffects: false,
        },
    ]);
    return { graph, box };
}

/**
 * @param {object} db
 * @returns {Promise<Array<object>>}
 */
async function readOrderedRecords(db) {
    const replica = await readRetainedJournal(db.getSchemaStorage().journal);
    if (replica instanceof Error) {
        throw replica;
    }
    const records = [...replica.values()].flat();
    records.sort((left, right) => sequenceOf(left) - sequenceOf(right));
    return records;
}

/**
 * @param {object} record
 * @returns {number}
 */
function sequenceOf(record) {
    return Number(journalRecordIdToString(record.id).split(":")[1]);
}

describe("ordinary recompute preserves a skewed value timestamp pair", () => {
    /** @type {object} */
    let capabilities;
    /** @type {object} */
    let db;
    /** @type {import("../src/generators/incremental_graph").IncrementalGraph} */
    let graph;
    /** @type {object} */
    let box;

    beforeEach(async () => {
        capabilities = testCapabilities();
        db = await getRootDatabase(capabilities);
        const made = await makeGraph(capabilities, db);
        graph = made.graph;
        box = made.box;
    });

    afterEach(async () => {
        await db.close();
    });

    test("a changed recompute keeps createdAt=Tfuture and commits modifiedAt=Tnow", async () => {
        capabilities.datetime.setDateTime(fromISOString(TFUTURE));
        await graph.pull("all_events");

        const materialized = (await readOrderedRecords(db)).filter(isValueEvent);
        expect(materialized).toHaveLength(1);
        expect(materialized[0].createdAt).toBe(TFUTURE);
        expect(materialized[0].modifiedAt).toBe(TFUTURE);

        box.value = [
            ...box.value,
            {
                id: eventId.fromString("aaaaaaaaa:2"),
                date: fromISOString("2020-01-01T10:00:00.000Z"),
                original: "the sky is blue",
                input: "the sky is blue",
                creator: CREATOR,
            },
        ];
        capabilities.datetime.setDateTime(fromISOString(TNOW));
        await graph.invalidate("all_events");
        await graph.pull("all_events");

        const values = (await readOrderedRecords(db)).filter(isValueEvent);
        expect(values).toHaveLength(2);
        const recomputed = values[values.length - 1];
        expect(recomputed.createdAt).toBe(TFUTURE);
        expect(recomputed.modifiedAt).toBe(TNOW);
        expect(await graph.getFreshness("all_events")).toBe("up-to-date");
    });
});
