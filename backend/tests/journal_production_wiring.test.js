/**
 * The production path's own emission claims, pinned one clause at a time.
 *
 * `incremental-graph-journal-emission.md` is the governing specification and
 * `journal_atomicity_requirement.test.js` pins the recovered-state consequence of
 * `$id-2048186621237391`. This suite pins the individual clauses which the commit seam
 * of the production path discharges, so that each of them is load-bearing rather than
 * implied by the presence of some journal output:
 *
 * - "Explicit invalidation" and "Propagated persistent staleness": the record shapes an
 *   explicit invalidation and its staleness propagation must have, and which are two
 *   different records with two different scopes;
 * - "Publication order": a referenced ValueEvent precedes the references to it;
 * - "Staging and serialized finalization" step 6: same-publication ValueId references
 *   resolve to the occurrences this very publication creates;
 * - the invalidation is one atomic write carrying the freshness it writes and the
 *   records which state it.
 *
 * Everything here drives `createIncrementalGraph`, then `pull` and `invalidate`, over
 * the repository's real computors. Emission's own suites prove that `finalizeEmission`
 * builds correct records from correct intents; nothing else proves that the production
 * path supplies the intents these clauses describe.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const { readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");
const {
    isInvalidateEvent,
    isValidateEvent,
    isValueEvent,
    journalRecordIdToString,
} = require("../src/generators/incremental_graph/journal");

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
 * The real graph the suite operates on: three real heads whose computors need neither
 * a filesystem nor an AI capability.
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
    fs.mkdtempSync(path.join(os.tmpdir(), "journal-production-wiring-"));
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return capabilities;
}

/**
 * The retained records of a database in the local writer's own allocation order, which
 * is the order the publication used.
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
 * The local writer sequence a record occupies, which is the order the publication
 * allocated it in.
 * @param {object} record
 * @returns {number}
 */
function sequenceOf(record) {
    return Number(journalRecordIdToString(record.id).split(":")[1]);
}

/**
 * The records an operation appended to those already retained, so that a claim about
 * what one operation published is not satisfied by records an earlier one published.
 * @param {ReadonlyArray<object>} published
 * @param {ReadonlyArray<object>} after
 * @returns {Array<object>}
 */
function appendedRecords(published, after) {
    const publishedIds = new Set(published.map((record) => journalRecordIdToString(record.id)));
    return after.filter((record) => !publishedIds.has(journalRecordIdToString(record.id)));
}

/**
 * The head name of the node a record is about.
 * @param {object} record
 * @returns {string}
 */
function nodeHeadOf(record) {
    return record.node.head;
}

/**
 * The text form of the ids of the given records, in the order given, so that two reads
 * of the same journal can be compared without comparing record identity.
 * @param {ReadonlyArray<object>} records
 * @returns {Array<string>}
 */
function idTextsOf(records) {
    /** @type {Array<string>} */
    const texts = [];
    for (const record of records) {
        texts.push(record.kind + "@" + journalRecordIdToString(record.id));
    }
    return texts;
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
 * Record every batch the schema storage issues, naming the sublevels each carried.
 * @param {object} db
 * @returns {Array<Array<string>>}
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

describe("the production path emits the records the emission law describes", () => {
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

    test("an explicit invalidation emits a node-scoped explicit record for the node itself", async () => {
        await graph.pull("event_context");
        const published = await readOrderedRecords(db);
        await graph.invalidate("meta_events");
        const appended = appendedRecords(published, await readOrderedRecords(db));

        const explicit = appended.filter(isInvalidateEvent).filter((record) => record.reason === "explicit");
        expect(explicit).toHaveLength(1);
        expect(nodeHeadOf(explicit[0])).toBe("meta_events");
        expect(explicit[0].scope.kind).toBe("node");
        expect(explicit[0].scope).not.toHaveProperty("value");
    });

    test("staleness propagation emits value-scoped records naming the exact dependent occurrences", async () => {
        await graph.pull("event_context");
        const published = await readOrderedRecords(db);
        await graph.invalidate("meta_events");
        const appended = appendedRecords(published, await readOrderedRecords(db));

        const committedValueIds = new Set(
            published.filter(isValueEvent).map((record) => journalRecordIdToString(record.id))
        );
        const propagated = appended
            .filter(isInvalidateEvent)
            .filter((record) => record.reason === "propagated");

        // The dependent of the invalidated node keeps its materialization and its
        // occurrence, and only becomes stale, so the invalidation publishes exactly one
        // value-scoped record, naming the occurrence the committed ValueEvent created.
        expect(propagated).toHaveLength(1);
        expect(nodeHeadOf(propagated[0])).toBe("event_context");
        expect(propagated[0].scope.kind).toBe("value");
        expect(committedValueIds.has(journalRecordIdToString(propagated[0].scope.value))).toBe(true);
        expect(await graph.getFreshness("event_context")).toBe("potentially-outdated");
    });

    test("the cause of a propagated staleness is published before the effect it causes", async () => {
        await graph.pull("event_context");
        const published = await readOrderedRecords(db);
        await graph.invalidate("meta_events");
        const invalidations = appendedRecords(published, await readOrderedRecords(db)).filter(isInvalidateEvent);

        const explicit = invalidations.find((record) => record.reason === "explicit");
        const propagated = invalidations.find((record) => record.reason === "propagated");
        expect(explicit).toBeDefined();
        expect(propagated).toBeDefined();
        expect(sequenceOf(explicit)).toBeLessThan(sequenceOf(propagated));
    });

    test("same-publication references resolve to the occurrences this publication creates", async () => {
        await graph.pull("event_context");

        const records = await readOrderedRecords(db);
        const valueIds = new Set(records.filter(isValueEvent).map((record) => journalRecordIdToString(record.id)));
        const validations = records.filter(isValidateEvent);

        // Every dependent validates against an occurrence of the input it names, and a
        // dependency materialized by this same pull has no committed occurrence yet, so
        // the reference must resolve to the ValueEvent of this very publication.
        expect(validations.length).toBeGreaterThan(0);
        for (const validation of validations) {
            expect(valueIds.has(journalRecordIdToString(validation.value))).toBe(true);
            for (const entry of validation.basis) {
                expect(valueIds.has(journalRecordIdToString(entry.value))).toBe(true);
            }
        }
    });

    test("a referenced ValueEvent precedes the records which reference it", async () => {
        await graph.pull("event_context");

        const records = await readOrderedRecords(db);
        const positionById = new Map(records.map((record, position) => [journalRecordIdToString(record.id), position]));

        for (const validation of records.filter(isValidateEvent)) {
            const referenced = positionById.get(journalRecordIdToString(validation.value));
            expect(referenced).toBeDefined();
            expect(referenced).toBeLessThan(positionById.get(journalRecordIdToString(validation.id)));
            for (const entry of validation.basis) {
                const basisPosition = positionById.get(journalRecordIdToString(entry.value));
                expect(basisPosition).toBeDefined();
                expect(basisPosition).toBeLessThan(positionById.get(journalRecordIdToString(validation.id)));
            }
        }
    });

    test("an explicit invalidation is one atomic write carrying the freshness it writes and the records which state it", async () => {
        await graph.pull("event_context");
        const issued = instrumentBatches(db);

        await graph.invalidate("meta_events");

        expect(issued).toHaveLength(1);
        expect(issued[0]).toContain("freshness");
        expect(issued[0]).toContain("journal");
    });

    test("a pull which changes no persisted state publishes no journal record", async () => {
        await graph.pull("event_context");
        const before = await readOrderedRecords(db);

        await graph.pull("event_context");

        const after = await readOrderedRecords(db);
        expect(after).toHaveLength(before.length);
                expect(idTextsOf(after)).toEqual(idTextsOf(before));
    });
});
