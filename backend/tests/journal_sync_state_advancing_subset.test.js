/**
 * `incremental-graph-journal-testing.md` §Synchronization result reports state
 * advancement, third bullet: a sync from a source whose retained Journal is a
 * subset of the receiver's returns `stateAdvancing == false`.
 *
 * The first two bullets (import returns true, immediate repeat returns false)
 * and the fourth (own-writer-ahead refusal) are pinned in
 * `journal_sync.test.js`. This regression pins the remaining subset case: the
 * receiver already retains everything the source holds, so the operation
 * imports nothing, authors nothing, and reports no state advancement.
 */

const {
    journalAuthorToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeJournalSequence,
    makeReplicaSource,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    nodeKeyToCanonicalString,
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
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const PAYLOAD = { type: "entry_description", description: "x" };
const INSTANT = 1700000000000;

function chainInputs(nodeKeyString) {
    if (nodeKeyString === KEY_B) {
        return [KEY_A];
    }
    return [];
}

function contextOf(coordinates) {
    return makeJournalFrontierFromText(coordinates);
}

function observedUpTo(writer, sequence, observed) {
    const previous = Number(sequence) - 1;
    if (previous === 0) {
        return [...observed];
    }
    return [...observed, [writer, String(previous)]];
}

function made(value) {
    if (value instanceof Error) {
        throw new Error("the fixture built an invalid record: " + value.message);
    }
    return value;
}

function authorityOf(physical) {
    return makeAuthorityTime(physical, "0");
}

function identifierOf(nodeKeyString) {
    return JSON.parse(nodeKeyString).args[0].id + "-abcdefghi";
}

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

function replicaOf(records) {
    const byWriter = new Map();
    for (const record of records) {
        const name = journalAuthorToString(record.id.author);
        const stream = byWriter.get(name) ?? [];
        stream.push(record);
        byWriter.set(name, stream);
    }
    return makeJournalReplica([...byWriter.entries()]);
}

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

async function retainedStateOf(receiver, currentInputKeysOfNode) {
    const built = await buildRetainedReplayState({
        source: makeReplicaSource(replicaOf(receiver)),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        currentInputKeysOfNode,
    });
    if ("error" in built) {
        throw new Error("the receiver's retained state could not be built: " + built.error.message);
    }
    expect(isRetainedReplayState(built.state)).toBe(true);
    return built.state;
}

async function synchronize(options) {
    const identity = new SnapshotIdentityClass("v1", "scheme");
    const result = await synchronizeRetainedJournal({
        receiver: makeReplicaSource(replicaOf(options.receiver)),
        source: makeReplicaSource(replicaOf(options.source)),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        committed: committedAfter(options.receiver, options.authorityPhysical),
        observedHighWater: authorityOf(options.authorityPhysical),
        publicationInstant: INSTANT,
        currentInputKeysOfNode: chainInputs,
        receiverIdentity: identity,
        sourceIdentity: identity,
        retainedState: await retainedStateOf(options.receiver, chainInputs),
    });
    return await withCollectedRecords(result);
}

function outcomeOf(result) {
    if (!("outcome" in result)) {
        throw new Error("synchronization failed with " + result.error.name + ": " + result.error.message);
    }
    expect(isSyncOutcome(result.outcome)).toBe(true);
    return result.outcome;
}

describe("SyncResult.stateAdvancing for a subset source", () => {
    test("a source whose retained journal is a subset of the receiver's advances no state", async () => {
        const localPrefix = [
            ...materialize({
                writer: WRITER_LOCAL,
                sequence: "1",
                node: NODE_A,
                context: [],
                basis: [],
            }),
            ...materialize({
                writer: WRITER_LOCAL,
                sequence: "3",
                node: NODE_B,
                context: [],
                basis: [{ node: NODE_A, value: WRITER_LOCAL + ":1" }],
            }),
        ];
        const peerMaterialization = materialize({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_C,
            context: [[WRITER_LOCAL, "4"]],
            basis: [{ node: NODE_B, value: WRITER_LOCAL + ":3" }],
        });
        const receiver = [...localPrefix, ...peerMaterialization];
        const subsetSource = [...localPrefix];

        const result = await synchronize({
            receiver,
            source: subsetSource,
            authorityPhysical: 400,
        });

        const outcome = outcomeOf(result);
        expect(outcome.records).toEqual([]);
        expect(outcome.stateAdvancing).toBe(false);
    });
});
