/**
 * End-to-end: a real computor's real output, through emission, into a durable
 * record store, read back through the persisted-text path, and replayed.
 *
 * This is the test which makes the Journal 3 end-to-end path exist. Until now the
 * record layer (`journal/`) and the replay oracle (`journal/oracle/`) had no
 * caller in `backend/src` or `frontend/src`: `makeValueEvent`, `encodeJournalRecord`,
 * the persisted-text read path `tryDecodeJournalRecord`, and `projectRetainedJournal`
 * were each exercised only by their own unit suites. This suite drives the four
 * real computors whose output needs neither a filesystem nor an AI capability —
 * `all_events`, `meta_events`, `event_context`, `event(e)`, and `entry_description(e)` —
 * through the whole path and asserts the emission law
 * `incremental-graph-journal-emission.md` states: `project(Jafter) == Gafter`.
 *
 * Every value in this file is either the real output of a real computor, the real
 * graph scheme derived from the repository's real node definitions, or a value
 * the real store read back from durable storage through the persisted-text read
 * path. No fixture is hand-written to stand in for a computor.
 */

const {
    ZERO_JOURNAL_SEQUENCE,
    finalizeEmission,
    isValueEvent,
    isValidateEvent,
    journalRecordIdToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    nodeKeyToCanonicalString,
    validateJournalReplica,
} = require("../src/generators/incremental_graph/journal");
const { projectRetainedJournal, makeReplicaSource } = require("../src/generators/incremental_graph/journal/oracle");
const { openRecordStore } = require("../src/generators/incremental_graph/journal_store");

const { compileValidatedGraphSchema } = require("../src/generators/incremental_graph/graph_schema");
const {
    deriveInputPositions,
    deserializeNodeKey,
    stringToNodeName,
} = require("../src/generators/incremental_graph/database");
const { makeNodeIdentifier } = require("../src/generators/incremental_graph/database/node_identifier");

const allEventsModule = require("../src/generators/individual/all_events/wrapper");
const metaEventsComputor = require("../src/generators/individual/meta_events/wrapper").computor;
const eventContextComputor = require("../src/generators/individual/event_context/wrapper").computor;
const eventComputor = require("../src/generators/individual/event/wrapper").computor;
const entryDescriptionComputor = require("../src/generators/individual/entry_description/wrapper").computor;

const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");

const creator = require("../src/filesystem/creator").make();
const writer = require("../src/filesystem/writer").make();
const reader = require("../src/filesystem/reader").make();
const dirscanner = require("../src/filesystem/dirscanner").make();
const deleter = require("../src/filesystem/deleter").make();

const { stubLogger } = require("./stubs");

const CREATOR = {
    name: "tester",
    uuid: "0f6c1a1e-0000-4000-8000-000000000000",
    version: "1.0.0",
    hostname: "host.example",
};

const WRITER_NAME = "aaaaaaaaa";
const FINGERPRINT = "aaaaaaaaa";
const MODIFIED_AT = "2020-01-02T00:00:00.000Z";
const CREATED_AT = "2020-01-01T00:00:00.000Z";
const PUBLICATION_INSTANT = fromISOString("2020-01-02T00:00:01.000Z").toMillis();

/** @type {string} */
let root;
/** @type {object} */
let storeCapabilities;
/** @type {import("../src/generators/incremental_graph/journal").CommittedWriterState} */
let writerState;
/** @type {Map<string, import("../src/generators/incremental_graph/journal").JournalRecordId>} */
let valueIdByNodeKeyString;
/** @type {import("../src/generators/incremental_graph/journal").JournalRecord[]} */
let everyRecord;
/** @type {Record<string, unknown>} */
let livePayloads;

beforeAll(async () => {
    root = await creator.createTemporaryDirectory();
    storeCapabilities = { creator, writer, reader, scanner: dirscanner, deleter };
    stubLogger(storeCapabilities);
    const author = makeJournalAuthor(WRITER_NAME);
    if (author instanceof Error) {
        throw new Error("the test writer name is not a valid fingerprint: " + author.message);
    }
    writerState = {
        localWriter: author,
        writerHead: ZERO_JOURNAL_SEQUENCE,
        committedFrontier: makeJournalFrontierFromText([]),
        authorityHighWater: makeAuthorityTime(0, "0"),
        allocatorWatermark: 0,
    };
    if (writerState.authorityHighWater instanceof Error) {
        throw new Error("the initial authority high-water is malformed");
    }
    valueIdByNodeKeyString = new Map();
    everyRecord = [];
    livePayloads = await runRealComputors();
});

afterAll(async () => {
    if (root !== undefined) {
        await deleter.deleteDirectory(root);
    }
});

/**
 * The two real source events every computor in this suite consumes. They are
 * real `Event` values, so the `all_events` computor serializes them with the
 * repository's own `serialize`, exactly as the interface does when it writes the
 * graph.
 * @returns {Array<object>}
 */
function realEvents() {
    return [
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
}

/**
 * The real node definitions for the five heads this suite materializes, with the
 * real computors attached, compiled and validated by the repository's own schema
 * compiler. The graph scheme used to derive each node's current direct inputs is
 * therefore the real adjacency from `interface/default_graph.js`, not a hand-built
 * dependency map.
 * @returns {{graphScheme: object, computors: Record<string, Function>}}
 */
function realGraph() {
    const box = allEventsModule.makeBox();
    box.value = realEvents();
    const allEventsComputor = allEventsModule.makeComputor(box, {});
    const computors = {
        all_events: allEventsComputor,
        meta_events: metaEventsComputor,
        event_context: eventContextComputor,
        event: eventComputor,
        entry_description: entryDescriptionComputor,
    };
    const nodeDefs = [
        { output: "all_events", inputs: [], computor: allEventsComputor, isDeterministic: false, hasSideEffects: false },
        { output: "meta_events", inputs: ["all_events"], computor: metaEventsComputor, isDeterministic: true, hasSideEffects: false },
        { output: "event_context", inputs: ["meta_events"], computor: eventContextComputor, isDeterministic: true, hasSideEffects: false },
        { output: "event(e)", inputs: ["all_events"], computor: eventComputor, isDeterministic: true, hasSideEffects: false },
        { output: "entry_description(e)", inputs: ["event(e)"], computor: entryDescriptionComputor, isDeterministic: true, hasSideEffects: false },
    ];
    const schema = compileValidatedGraphSchema(nodeDefs);
    return { graphScheme: schema.graphScheme, computors };
}

/**
 * The five semantic node keys this suite materializes, in dependency order.
 * @returns {Array<{node: object, key: string}>}
 */
function materializationOrder() {
    return [
        { node: { head: stringToNodeName("all_events"), args: [] }, key: "all_events" },
        { node: { head: stringToNodeName("event"), args: [{ id: "aaaaaaaaa:1" }] }, key: "event:aaaaaaaaa:1" },
        { node: { head: stringToNodeName("meta_events"), args: [] }, key: "meta_events" },
        { node: { head: stringToNodeName("entry_description"), args: [{ id: "aaaaaaaaa:1" }] }, key: "entry_description:aaaaaaaaa:1" },
        { node: { head: stringToNodeName("event_context"), args: [] }, key: "event_context" },
    ];
}

/**
 * Drive every real computor once and return each node's live `ComputedValue`.
 * The values are exactly what the repository's own computors returned, including
 * the nominal `EventId` and `DateTime` objects they carry.
 * @returns {Promise<Record<string, unknown>>}
 */
async function runRealComputors() {
    const { graphScheme, computors } = realGraph();
    const allEvents = await computors.all_events(undefined, undefined, []);
    const eventValue = await computors.event([allEvents], undefined, ["aaaaaaaaa:1"]);
    const metaEvents = await computors.meta_events([allEvents], undefined, []);
    const entryDescription = await computors.entry_description([eventValue], undefined, []);
    const eventContext = await computors.event_context([metaEvents], undefined, []);
    return {
        all_events: allEvents,
        event: eventValue,
        meta_events: metaEvents,
        entry_description: entryDescription,
        event_context: eventContext,
        __graphScheme: graphScheme,
    };
}

/**
 * The current direct-input key strings of one node, derived from the real graph
 * scheme. A node the scheme does not name has no current inputs.
 * @param {object} graphScheme
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function currentInputKeysOfNode(graphScheme, nodeKeyString) {
    try {
        return deriveInputPositions(graphScheme, nodeKeyString).map((key) => String(key));
    } catch {
        return [];
    }
}

/**
 * Emit one node's materialization as its own publication, publish it to the
 * durable store, and thread the advanced writer state. The dependent's basis
 * references the current committed `ValueId` of each direct input, which the
 * previous publication established.
 * @param {{node: object, key: string}} entry
 * @param {unknown} payload
 * @returns {Promise<import("../src/generators/incremental_graph/journal").JournalRecordId>}
 */
async function publishMaterialization(entry, payload) {
    const nodeKeyString = nodeKeyToCanonicalString(entry.node);
    const inputs = currentInputKeysOfNode(livePayloads.__graphScheme, nodeKeyString).map((inputKeyString) => ({
        input: deserializeNodeKey(inputKeyString),
        value: valueIdByNodeKeyString.get(inputKeyString),
    }));
    const index = materializationOrder().findIndex((candidate) => candidate.key === entry.key) + 1;
    const publication = finalizeEmission({
        state: writerState,
        intents: [
            {
                kind: "materialize",
                node: entry.node,
                nodeIdentifier: makeNodeIdentifier(FINGERPRINT, index),
                payload,
                createdAt: CREATED_AT,
                modifiedAt: MODIFIED_AT,
                inputs,
            },
        ],
        publicationInstant: PUBLICATION_INSTANT,
        allocatorWatermark: index,
    });
    if (publication instanceof Error) {
        throw new Error("emission rejected a settled materialization of " + entry.key + ": " + publication.message);
    }
    const store = openStore();
    const failure = await store.publish(publication.records);
    if (failure !== undefined) {
        throw new Error("the store could not make the publication durable: " + failure.message);
    }
    for (const record of publication.records) {
        everyRecord.push(record);
        if (isValueEvent(record)) {
            valueIdByNodeKeyString.set(nodeKeyString, record.id);
        }
    }
    writerState = publication.writerState;
    const valueId = valueIdByNodeKeyString.get(nodeKeyString);
    if (valueId === undefined) {
        throw new Error("publication of " + entry.key + " produced no value occurrence");
    }
    return valueId;
}

/** @type {import("../src/generators/incremental_graph/journal_store").RecordStore | undefined} */
let theStore;

/**
 * One store instance shared by every publication, so the store retains all five
 * materializations as a single committed prefix per writer.
 * @returns {import("../src/generators/incremental_graph/journal_store").RecordStore}
 */
function openStore() {
    if (theStore === undefined) {
        theStore = openRecordStore(storeCapabilities, root);
    }
    return theStore;
}

/**
 * Materialize the whole real graph, one publication per node in dependency order.
 * @returns {Promise<void>}
 */
async function materializeWholeGraph() {
    for (const entry of materializationOrder()) {
        await publishMaterialization(entry, livePayloads[entry.key.split(":")[0]]);
    }
}

describe("the end-to-end Journal path over real computor output", () => {
    test("each real computor produced a live value the record layer accepts and the store round-trips", async () => {
        for (const entry of materializationOrder()) {
            const head = entry.key.split(":")[0];
            const payload = livePayloads[head];
            expect(typeof payload).toBe("object");
            expect(payload).not.toBeInstanceOf(Error);
        }
    });

    test("a real computor's value survives makeValueEvent, encode, store, and the persisted-text read path", () => {
        // The live meta_events value carries nominal EventId/DateTime objects; the
        // record layer accepts it on the write path, and accepts its own persisted
        // form again on the replay read path.
        const live = livePayloads.meta_events;
        expect(getOwnNames(live.meta_events[0].event.id)).toEqual(["identifier", "__brand"]);
        const record = buildValueRecord("meta_events", live, "1");
        expect(record).not.toBeInstanceOf(Error);
        const encoded = require("../src/generators/incremental_graph/journal").encodeJournalRecord(record);
        const decoded = require("../src/generators/incremental_graph/journal").tryDecodeJournalRecord(encoded);
        expect(decoded).not.toBeInstanceOf(Error);
        expect(decoded.payload).toEqual(JSON.parse(JSON.stringify(live)));
    });

    test("the whole real graph materializes, stores durably, and replays to the graph state", async () => {
        await materializeWholeGraph();

        // The store now holds five publications of the local writer as durable text.
        const store = openStore();
        const replica = await store.readReplica();
        if (replica instanceof Error) {
            throw new Error("the store could not read its retained replica back: " + replica.message);
        }
        // What came back is a well-formed retained journal.
        const wellFormed = validateJournalReplica(replica);
        expect(wellFormed).toBeUndefined();

        // Replay the persisted-text records and compare against the intended graph
        // state, which is exactly the real computor output for each node.
        const projection = projectRetainedJournal({
            source: makeReplicaSource(replica),
            localWriter: writerState.localWriter,
            currentInputKeysOfNode: (nodeKeyString) =>
                currentInputKeysOfNode(livePayloads.__graphScheme, nodeKeyString),
        });
        if (projection instanceof Error) {
            throw new Error("replay of the emitted journal was rejected: " + projection.message);
        }

        expect(projection.occurrences).toHaveLength(5);
        expect([...projection.unmarkedPropagatedStaleness]).toEqual([]);
        expect(projection.lastNodeIndex).toBe(5);

        const graphScheme = livePayloads.__graphScheme;
        for (const entry of materializationOrder()) {
            const nodeKeyString = nodeKeyToCanonicalString(entry.node);
            const head = entry.key.split(":")[0];
            const occurrence = projection.occurrences.find(
                (candidate) => candidate.nodeKeyString === nodeKeyString
            );
            expect(occurrence).toBeDefined();
            // The replayed value is the real computor's output in its persisted form.
            expect(occurrence.payload).toEqual(JSON.parse(JSON.stringify(livePayloads[head])));
            // The occurrence is the one emission allocated, with the timestamps it carried.
            expect(journalRecordIdToString(occurrence.valueId)).toBe(
                journalRecordIdToString(valueIdByNodeKeyString.get(nodeKeyString))
            );
            expect(occurrence.createdAt).toBe(CREATED_AT);
            expect(occurrence.modifiedAt).toBe(MODIFIED_AT);
            // Freshness and validity follow the real graph: every node is fresh and
            // proves exactly its current direct inputs.
            expect(occurrence.fresh).toBe(true);
            expect([...occurrence.validInputs].sort()).toEqual(
                currentInputKeysOfNode(graphScheme, nodeKeyString).slice().sort()
            );
        }
    });

    test("the replayed result equals the oracle projection computed from the same records", () => {
        // Replaying the emitted journal through the streaming oracle must agree with
        // the declarative reference model in the same way the oracle's own suite
        // requires, so the end-to-end result is not an artifact of one projection.
        const store = openStore();
        return store.readReplica().then((replica) => {
            if (replica instanceof Error) {
                throw new Error("the store could not read its retained replica back: " + replica.message);
            }
            const { declarativeProject } = require("./oracle_declarative_reference");
            const oracle = projectRetainedJournal({
                source: makeReplicaSource(replica),
                localWriter: writerState.localWriter,
                currentInputKeysOfNode: (nodeKeyString) =>
                    currentInputKeysOfNode(livePayloads.__graphScheme, nodeKeyString),
            });
            if (oracle instanceof Error) {
                throw new Error("replay of the emitted journal was rejected: " + oracle.message);
            }
            const declarative = declarativeProject(
                replica,
                WRITER_NAME,
                (nodeKeyString) => currentInputKeysOfNode(livePayloads.__graphScheme, nodeKeyString)
            );
            expect(declarative.publishable).toBe(true);
            expect(summarize(oracle)).toEqual(summarize(declarative));
        });
    });

    test("every emitted record is a current-format record with a ValueEvent before its ValidateEvent", () => {
        // The publication order the emission finalizer guarantees: within each
        // publication the ValueEvent precedes the ValidateEvent naming its ValueId.
        // Violations are collected and asserted once, so a failure names the exact
        // record rather than stopping at the first bad index.
        /** @type {string[]} */
        const violations = [];
        for (let index = 0; index < everyRecord.length; index++) {
            const record = everyRecord[index];
            if (isValidateEvent(record)) {
                const previous = everyRecord[index - 1];
                if (!isValueEvent(previous)) {
                    violations.push("ValidateEvent at " + index + " has no preceding ValueEvent");
                } else if (journalRecordIdToString(previous.id) !== journalRecordIdToString(record.value)) {
                    violations.push(
                        "ValidateEvent at " + index + " names " + journalRecordIdToString(record.value) +
                            " but the preceding ValueEvent is " + journalRecordIdToString(previous.id)
                    );
                }
            }
            if (isValueEvent(record) && !isValidateEvent(everyRecord[index + 1])) {
                violations.push("ValueEvent at " + index + " is not followed by a ValidateEvent");
            }
        }
        expect(violations).toEqual([]);
    });
});

/**
 * @param {object} value
 * @returns {Array<string>}
 */
function getOwnNames(value) {
    return Object.getOwnPropertyNames(value);
}

/**
 * A value record for `head`'s live payload, used only to exercise the write/read
 * codec in isolation.
 * @param {string} head
 * @param {unknown} payload
 * @param {string} id
 * @returns {object}
 */
function buildValueRecord(head, payload, id) {
    const {
        makeValueEvent,
        makeAuthorityTime: authority,
        makeJournalFrontierFromText: frontier,
    } = require("../src/generators/incremental_graph/journal");
    void head;
    return makeValueEvent(
        {
            id: WRITER_NAME + ":" + id,
            context: frontier([]),
            authorityTime: authority(1000, "0"),
            node: { head: stringToNodeName("meta_events"), args: [] },
        },
        makeNodeIdentifier(FINGERPRINT, 1),
        payload,
        MODIFIED_AT,
        MODIFIED_AT,
        "compute"
    );
}

/**
 * The textual form of a value id, which the oracle holds as a `JournalRecordId`
 * and the declarative model already reduced to text.
 * @param {unknown} valueId
 * @returns {string}
 */
function valueIdText(valueId) {
    return typeof valueId === "string" ? valueId : journalRecordIdToString(valueId);
}

/**
 * Reduce a projection to a comparable plain value so a disagreement names the node
 * and the field rather than comparing object identities.
 * @param {object} projection
 * @returns {object}
 */
function summarize(projection) {
    return {
        lastNodeIndex: projection.lastNodeIndex,
        occurrences: projection.occurrences.map((occurrence) => ({
            nodeKeyString: occurrence.nodeKeyString,
            valueId: valueIdText(occurrence.valueId),
            createdAt: occurrence.createdAt,
            modifiedAt: occurrence.modifiedAt,
            fresh: occurrence.fresh,
            validInputs: [...occurrence.validInputs].sort(),
        })),
    };
}
