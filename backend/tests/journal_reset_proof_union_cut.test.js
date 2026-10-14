/**
 * Reset reads the proof union at the fixed post-value-repair cut.
 *
 * `incremental-graph-journal-reset.md` §Pass 2 requires the eligible effective
 * proof union to be read from the fixed cut Pass 1 established, and
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary requires
 * the staged summary's selected occurrences to be the ones that cut settled. The
 * selected occurrences are written by the projection, so a reset which reads the
 * union before taking that cut under-approximates the proof barriers it must
 * author and can reject a valid reset.
 *
 * This fixture makes the raw union select a preserved imported occurrence whose
 * authority beats the receiver's own selected occurrence, so the pre-reset
 * selected occurrence names the wrong ValueId. Reading the union at the fixed
 * cut authors the required barrier; reading it early does not.
 */

const {
    ProjectionClass,
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

const { SnapshotIdentityClass } = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
    makeResetSource,
    resetToSource,
} = require("../src/generators/incremental_graph/journal_reset");

const NODE_D = { head: "event", args: [{ id: 4 }] };
const NODE_K = { head: "event", args: [{ id: 2 }] };
const KEY_D = nodeKeyToCanonicalString(NODE_D);
const KEY_K = nodeKeyToCanonicalString(NODE_K);
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const PAYLOAD_D = { type: "entry_description", description: "d" };
const PAYLOAD_K = { type: "entry_description", description: "k" };

const LOCAL = makeJournalAuthor("aaaaaaaaa");
const PEER = makeJournalAuthor("bbbbbbbbb");

/**
 * @param {number} physical
 * @param {number} [logical]
 */
function authority(physical, logical) {
    return makeAuthorityTime(physical, String(logical === undefined ? 0 : logical));
}

/**
 * @param {ReadonlyArray<string>} coordinates
 */
function ctx(coordinates) {
    return makeJournalFrontierFromText(coordinates);
}

/**
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function schema(nodeKeyString) {
    return nodeKeyString === KEY_K ? [KEY_D] : [];
}

/**
 * @param {ReadonlyArray<object>} records
 */
function replicaOf(records) {
    const byWriter = new Map();
    for (const record of records) {
        const name = journalAuthorToString(record.id.author);
        const stream = byWriter.get(name) ?? [];
        stream.push(record);
        byWriter.set(name, stream);
    }
    const replica = makeJournalReplica([...byWriter.entries()]);
    if (replica instanceof Error) {
        throw new Error("the fixture built an invalid replica: " + replica.message);
    }
    return replica;
}

function receiverRecords() {
    return [
        makeValueEvent(
            { id: "aaaaaaaaa:1", context: ctx([]), authorityTime: authority(100, 0), node: NODE_D },
            "1-aaaaaaaaa",
            PAYLOAD_D,
            NOW,
            LATER,
            "compute"
        ),
        makeValueEvent(
            { id: "aaaaaaaaa:2", context: ctx([["aaaaaaaaa", "1"]]), authorityTime: authority(100, 1), node: NODE_K },
            "2-aaaaaaaaa",
            PAYLOAD_K,
            NOW,
            LATER,
            "compute"
        ),
        makeValidateEvent(
            { id: "aaaaaaaaa:3", context: ctx([["aaaaaaaaa", "2"]]), authorityTime: authority(100, 2), node: NODE_K },
            "aaaaaaaaa:2",
            [makeValidationBasisEntry(NODE_D, "aaaaaaaaa:1")],
            "compute"
        ),
    ];
}

function sourceRecords() {
    return [
        makeValueEvent(
            { id: "bbbbbbbbb:1", context: ctx([]), authorityTime: authority(200, 0), node: NODE_K },
            "2-aaaaaaaaa",
            PAYLOAD_K,
            NOW,
            LATER,
            "compute"
        ),
        makeValidateEvent(
            { id: "bbbbbbbbb:2", context: ctx([["bbbbbbbbb", "1"]]), authorityTime: authority(200, 1), node: NODE_K },
            "bbbbbbbbb:1",
            [makeValidationBasisEntry(NODE_D, "aaaaaaaaa:1")],
            "compute"
        ),
    ];
}

/**
 * A legal dependency-closed target: `D` present and `K` present with the source
 * occurrence's fields but no validity edge, so the committed `D -> K` edge must be
 * barriered.
 */
function targetProjection() {
    const dOccurrence = {
        nodeKeyString: KEY_D,
        nodeKey: NODE_D,
        valueId: { author: LOCAL, sequence: makeJournalSequence("1") },
        nodeIdentifier: "1-aaaaaaaaa",
        payload: PAYLOAD_D,
        createdAt: NOW,
        modifiedAt: LATER,
        fresh: true,
        validInputs: new Set(),
    };
    const kOccurrence = {
        nodeKeyString: KEY_K,
        nodeKey: NODE_K,
        valueId: { author: PEER, sequence: makeJournalSequence("1") },
        nodeIdentifier: "2-aaaaaaaaa",
        payload: PAYLOAD_K,
        createdAt: NOW,
        modifiedAt: LATER,
        fresh: false,
        validInputs: new Set(),
    };
    const occurrences = [dOccurrence, kOccurrence].sort((a, b) =>
        a.nodeKeyString < b.nodeKeyString ? -1 : 1
    );
    return new ProjectionClass(occurrences, new Map(), 0, PEER, new Set(), new Set());
}

function runReset() {
    const records = receiverRecords();
    const receiver = makeReplicaSource(replicaOf(records));
    const built = buildRetainedReplayState({
        source: receiver,
        localWriter: LOCAL,
        currentInputKeysOfNode: schema,
    });
    if ("error" in built) {
        throw new Error("the receiver fixture has no retained state: " + built.error.message);
    }
    const source = makeResetSource({
        databaseVersion: "v1",
        graphSchemeString: "scheme",
        journal: makeReplicaSource(replicaOf(sourceRecords())),
        projection: targetProjection(),
    });
    const last = records[records.length - 1];
    if (last === undefined) {
        throw new Error("the receiver fixture has no records");
    }
    return resetToSource({
        receiver,
        retainedState: built.state,
        source,
        localWriter: LOCAL,
        committed: {
            localWriter: LOCAL,
            writerHead: last.id.sequence,
            committedFrontier: ctx([["aaaaaaaaa", "3"]]),
            authorityHighWater: authority(500, 0),
            allocatorWatermark: 0,
        },
        observedHighWater: authority(500, 0),
        publicationInstant: 1700000000000,
        currentInputKeysOfNode: schema,
        receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
    });
}

describe("reset Pass 2 reads the proof union at the fixed post-value-repair cut", () => {
    test("a valid reset authors the proof barrier the pre-reset selection would omit", () => {
        const result = runReset();

        expect("error" in result).toBe(false);
        if ("error" in result) {
            return;
        }
        const authored = result.outcome.publication.records;
        const barriers = authored.filter(
            (record) => record.kind === "invalidate" && record.scope.kind === "proof"
        );
        expect(barriers).toHaveLength(1);
        const k = result.outcome.projection.occurrences.find(
            (occurrence) => occurrence.nodeKeyString === KEY_K
        );
        expect(k).toBeDefined();
        if (k === undefined) {
            return;
        }
        expect([...k.validInputs]).toEqual([]);
    });
});
