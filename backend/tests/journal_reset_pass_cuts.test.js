/**
 * How many projections reset reads, and which pass reads each.
 *
 * Every cut `resetToSource` takes is a projection of the retained replay state, so
 * a cut no pass reads is a projection built and discarded. The passes which read a
 * cut are Pass 2, which plans the barriers and the target validations against it,
 * and Pass 3, which plans the freshness markers against it and hands the final one
 * to the committed-result check. Pass 1 settles occurrences from the raw union's
 * selected heads and authors from the target's projection, so it reads no cut of
 * its own.
 */

const RETAINED_MODULE =
    "../src/generators/incremental_graph/journal_reset/retained";

let mockProjectionCount = 0;

jest.mock(RETAINED_MODULE, () => {
    const actual = jest.requireActual(RETAINED_MODULE);
    return {
        ...actual,
        /**
         * @param {import("../src/generators/incremental_graph/journal_reset").RetainedReplayState} retainedState
         */
        projectRetainedReplay: (retainedState) => {
            mockProjectionCount += 1;
            return actual.projectRetainedReplay(retainedState);
        },
    };
});

const {
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeJournalSequence,
    makeReplicaSource,
    makeAuthorityTime,
    makeValueEvent,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal");

const { SnapshotIdentityClass } = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
    makeResetSource,
    resetToSource,
} = require("../src/generators/incremental_graph/journal_reset");

const NODE_A = { head: "event", args: [{ id: 1 }] };
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const LOCAL_AUTHOR = makeJournalAuthor(WRITER_LOCAL);
const PEER_AUTHOR = makeJournalAuthor(WRITER_PEER);
const PAYLOAD = { type: "entry_description", description: "x" };
const INSTANT = 1700000000000;

/**
 * @template T
 * @param {T | Error} value
 * @returns {T}
 */
function made(value) {
    if (value instanceof Error) {
        throw new Error("the fixture built an invalid value: " + value.message);
    }
    return value;
}

/**
 * The source's single materialized leaf.
 */
function sourceLeaf() {
    const record = made(makeValueEvent(
        {
            id: WRITER_PEER + ":1",
            context: makeJournalFrontierFromText([]),
            authorityTime: makeAuthorityTime(10, "0"),
            node: NODE_A,
        },
        "1-abcdefghi",
        PAYLOAD,
        NOW,
        LATER,
        "compute"
    ));
    const journal = makeReplicaSource(made(makeJournalReplica([[WRITER_PEER, [record]]])));
    const projection = made(projectRetainedJournal({
        source: journal,
        localWriter: PEER_AUTHOR,
        currentInputKeysOfNode: () => [],
    }));
    return makeResetSource({
        databaseVersion: "v1",
        graphSchemeString: "scheme",
        journal,
        projection,
    });
}

/**
 * A reset of an empty receiver to the source's one leaf.
 */
function resetToLeaf() {
    const receiver = makeReplicaSource(made(makeJournalReplica([])));
    const built = buildRetainedReplayState({
        source: receiver,
        localWriter: LOCAL_AUTHOR,
        currentInputKeysOfNode: () => [],
    });
    if ("error" in built) {
        throw new Error("the receiver fixture has no retained replay state: " + built.error.message);
    }
    mockProjectionCount = 0;
    return resetToSource({
        receiver,
        retainedState: built.state,
        source: sourceLeaf(),
        localWriter: LOCAL_AUTHOR,
        committed: {
            localWriter: LOCAL_AUTHOR,
            writerHead: makeJournalSequence("0"),
            committedFrontier: makeJournalFrontierFromText([]),
            authorityHighWater: makeAuthorityTime(100, "0"),
            allocatorWatermark: 0,
        },
        observedHighWater: makeAuthorityTime(100, "0"),
        publicationInstant: INSTANT,
        currentInputKeysOfNode: () => [],
        receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
    });
}

beforeEach(() => {
    mockProjectionCount = 0;
});

describe("resetToSource, the projections its passes read", () => {
    test("one cut is read per pass which reads a cut, and Pass 1 reads none", () => {
        const result = resetToLeaf();

        expect("outcome" in result).toBe(true);
        expect(mockProjectionCount).toBe(3);
    });
});
