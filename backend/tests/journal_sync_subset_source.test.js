/**
 * `incremental-graph-journal-testing.md` §Synchronization result reports state
 * advancement requires that a sync from a source whose retained Journal is a
 * subset of the receiver's returns `stateAdvancing == false`.
 *
 * The first-import case (`true`) and the immediate-repeat case (`false`) are
 * pinned in `journal_sync.test.js`; the subset-source bullet had no production
 * coverage. The subject is `synchronizeRetainedJournal` itself, over a
 * supported graph plus Journal pair built by the same materialize/validate
 * helpers as the sibling suite.
 */

const {
    journalAuthorToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeJournalSequence,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    nodeKeyToCanonicalString,
    makeReplicaSource,
} = require("../src/generators/incremental_graph/journal");

const { withCollectedRecords } = require("./journal_record_growth_helper");

const {
    isSyncOutcome,
    SnapshotIdentityClass,
    synchronizeRetainedJournal,
} = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
    isRetainedReplayState,
} = require("../src/generators/incremental_graph/journal_retained");

const NODE_A = { head: "event", args: [{ id: 1 }] };
const NODE_B = { head: "event", args: [{ id: 2 }] };
const NODE_C = { head: "event", args: [{ id: 3 }] };
const KEY_A = nodeKeyToCanonicalString(NODE_A);
const KEY_B = nodeKeyToCanonicalString(NODE_B);
const KEY_C = nodeKeyToCanonicalString(NODE_C);
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const PAYLOAD = { type: "entry_description", description: "x" };
const INSTANT = 1700000000000;

/**
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function chainInputs(nodeKeyString) {
    if (nodeKeyString === KEY_B) {
        return [KEY_A];
    }
    if (nodeKeyString === KEY_C) {
        return [KEY_B];
    }
    return [];
}

/**
 * @param {ReadonlyArray<string>} coordinates
 */
function contextOf(coordinates) {
    return makeJournalFrontierFromText(coordinates);
}

/**
 * @param {string} writer
 * @param {string} sequence
 * @param {ReadonlyArray<string>} observed
 * @returns {ReadonlyArray<string>}
 */
function observedUpTo(writer, sequence, observed) {
    const previous = Number(sequence) - 1;
    if (previous === 0) {
        return [...observed];
    }
    return [...observed, [writer, String(previous)]];
}

/**
 * @param {number} physical
 * @param {number} [logical]
 */
function authorityOf(physical, logical) {
    return makeAuthorityTime(physical, String(logical === undefined ? 0 : logical));
}

/**
 * @param {string} nodeKeyString
 */
function identifierOf(nodeKeyString) {
    return JSON.parse(nodeKeyString).args[0].id + "-abcdefghi";
}

/**
 * @param {T | import("../src/generators/incremental_graph/journal").JournalError} value
 * @returns {T}
 * @template T
 */
function made(value) {
    if (value instanceof Error) {
        throw new Error("the fixture built an invalid record: " + value.message);
    }
    return value;
}

/**
 * @param {object} occurrence
 * @param {string} occurrence.writer
 * @param {string} occurrence.sequence
 * @param {import("../src/generators/incremental_graph/journal").NodeKey} occurrence.node
 * @param {ReadonlyArray<string>} occurrence.context
 * @param {ReadonlyArray<{node: import("../src/generators/incremental_graph/journal").NodeKey, value: string}>} occurrence.basis
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord[]}
 */
function materialize(occurrence) {
    const nodeKey = nodeKeyToCanonicalString(occurrence.node);
    const valueId = occurrence.writer + ":" + occurrence.sequence;
    const valueSequence = String(Number(occurrence.sequence) + 1);
    const validateId = occurrence.writer + ":" + valueSequence;
    return [
        made(makeValueEvent(
            {
                id: valueId,
                context: contextOf(observedUpTo(occurrence.writer, occurrence.sequence, occurrence.context)),
                authorityTime: authorityOf(Number(occurrence.sequence)),
                node: occurrence.node,
            },
            identifierOf(nodeKey),
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        )),
        made(makeValidateEvent(
            {
                id: validateId,
                context: contextOf(observedUpTo(occurrence.writer, valueSequence, occurrence.context)),
                authorityTime: authorityOf(Number(valueSequence)),
                node: occurrence.node,
            },
            valueId,
            occurrence.basis.map((entry) => makeValidationBasisEntry(entry.node, entry.value)),
            "compute"
        )),
    ];
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {import("../src/generators/incremental_graph/journal").JournalReplica}
 */
function replicaOf(records) {
    /** @type {Map<string, import("../src/generators/incremental_graph/journal").JournalRecord[]>} */
    const byWriter = new Map();
    for (const record of records) {
        const name = journalAuthorToString(record.id.author);
        const stream = byWriter.get(name) ?? [];
        stream.push(record);
        byWriter.set(name, stream);
    }
    return makeJournalReplica([...byWriter.entries()]);
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @param {number} authorityPhysical
 */
function committedAfter(records, authorityPhysical) {
    const own = records.filter(
        (record) => journalAuthorToString(record.id.author) === WRITER_LOCAL
    );
    const last = own[own.length - 1];
    return {
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        writerHead: last === undefined ? makeJournalSequence("0") : last.id.sequence,
        committedFrontier: contextOf(
            last === undefined ? [] : [[WRITER_LOCAL, last.id.sequence]]
        ),
        authorityHighWater: authorityOf(authorityPhysical),
        allocatorWatermark: 0,
    };
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} receiver
 * @returns {import("../src/generators/incremental_graph/journal_retained").RetainedReplayState}
 */
async function retainedStateOf(receiver) {
    const built = await buildRetainedReplayState({
        source: makeReplicaSource(replicaOf(receiver)),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        currentInputKeysOfNode: chainInputs,
    });
    if ("error" in built) {
        throw new Error("the receiver's retained state could not be built: " + built.error.message);
    }
    expect(isRetainedReplayState(built.state)).toBe(true);
    return built.state;
}

function receiverChain() {
    const a = materialize({
        writer: WRITER_LOCAL,
        sequence: "1",
        node: NODE_A,
        context: [],
        basis: [],
    });
    const b = materialize({
        writer: WRITER_LOCAL,
        sequence: "3",
        node: NODE_B,
        context: [],
        basis: [{ node: NODE_A, value: WRITER_LOCAL + ":1" }],
    });
    return [...a, ...b];
}

describe("synchronizeRetainedJournal, reporting state advancement", () => {
    test("a source whose retained journal is a subset of the receiver's does not advance state", async () => {
        const peerMaterialization = materialize({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_C,
            context: [[WRITER_LOCAL, "4"]],
            basis: [{ node: NODE_B, value: WRITER_LOCAL + ":3" }],
        });
        const receiver = [...receiverChain(), ...peerMaterialization];
        const subsetSource = receiverChain();
        const identity = new SnapshotIdentityClass("v1", "scheme");
        const result = await synchronizeRetainedJournal({
            receiver: makeReplicaSource(replicaOf(receiver)),
            source: makeReplicaSource(replicaOf(subsetSource)),
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            committed: committedAfter(receiver, 400),
            observedHighWater: authorityOf(400),
            publicationInstant: INSTANT,
            currentInputKeysOfNode: chainInputs,
            receiverIdentity: identity,
            sourceIdentity: identity,
            retainedState: await retainedStateOf(receiver),
        });
        const collected = await withCollectedRecords(result);
        expect("outcome" in collected).toBe(true);
        if (!("outcome" in collected)) {
            return;
        }
        expect(isSyncOutcome(collected.outcome)).toBe(true);
        expect(collected.outcome.publication.records).toEqual([]);
        expect(collected.outcome.stateAdvancing).toBe(false);
        expect(collected.outcome.projection.occurrences.map((occurrence) => occurrence.nodeKeyString))
            .toEqual([KEY_A, KEY_B, KEY_C]);
    });
});
