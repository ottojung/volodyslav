/**
 * The reset theorem's committed-result check.
 *
 * `incremental-graph-journal-reset.md` §Reset theorem makes the committed result
 * equal the target semantic graph: present keys, payloads, identifiers,
 * timestamps, freshness and validity edges. This file pins the occurrence state
 * half of that statement, which is checked after Passes 1-3 against the source's
 * committed projection.
 *
 * The occurrences reset settles on reach that check through three passes, so the
 * check is what refuses a result whose occurrence state is not the target's
 * whatever settled it. The fixture therefore perturbs the committed projection
 * the passes read their cuts from, which leaves the occurrence, its `ValueId`,
 * its freshness and its validity edges in place and moves exactly one occurrence
 * field, so each case turns on one comparison and not on the others.
 */

const RETAINED_MODULE =
    "../src/generators/incremental_graph/journal_reset/retained";

/**
 * @type {(occurrence: import("../src/generators/incremental_graph/journal").ProjectedOccurrence) => import("../src/generators/incremental_graph/journal").ProjectedOccurrence}
 */
let mockPerturbOccurrence = (occurrence) => occurrence;

jest.mock(RETAINED_MODULE, () => {
    const actual = jest.requireActual(RETAINED_MODULE);
    const { ProjectionClass } = jest.requireActual(
        "../src/generators/incremental_graph/journal"
    );
    return {
        ...actual,
        /**
         * @param {import("../src/generators/incremental_graph/journal_reset").RetainedReplayState} retainedState
         * @returns {import("../src/generators/incremental_graph/journal").Projection}
         */
        projectRetainedReplay: (retainedState) => {
            const cut = actual.projectRetainedReplay(retainedState);
            return new ProjectionClass(
                cut.occurrences.map(mockPerturbOccurrence),
                cut.freshness,
                cut.lastNodeIndex,
                cut.localWriter,
                cut.selfProofReadyNodes,
                cut.unmarkedPropagatedStaleness
            );
        },
    };
});

const {
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeAuthorityTime,
    makeJournalReplica,
    makeJournalSequence,
    makeReplicaSource,
    makeValueEvent,
    nodeKeyToCanonicalString,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal");

const { nodeIdentifierFromString } = require("../src/generators/incremental_graph/database");

const { SnapshotIdentityClass } = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
    isResetOutcome,
    makeResetSource,
    resetToSource,
} = require("../src/generators/incremental_graph/journal_reset");

const NODE_A = { head: "event", args: [{ id: 1 }] };
const KEY_A = nodeKeyToCanonicalString(NODE_A);
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const LOCAL_AUTHOR = makeJournalAuthor(WRITER_LOCAL);
const PEER_AUTHOR = makeJournalAuthor(WRITER_PEER);
const PAYLOAD = { type: "entry_description", description: "x" };
const OTHER_PAYLOAD = { type: "entry_description", description: "y" };
const INSTANT = 1700000000000;
const IDENTIFIER = "1-abcdefghi";
const OTHER_IDENTIFIER = "2-abcdefghi";

/**
 * @param {ReadonlyArray<string>} coordinates
 */
function contextOf(coordinates) {
    return makeJournalFrontierFromText(coordinates);
}

/**
 * @param {number} physical
 */
function authorityOf(physical) {
    return makeAuthorityTime(physical, "0");
}

/**
 * @template T
 * @param {T | Error} value
 * @returns {T}
 */
function made(value) {
    if (value instanceof Error) {
        throw new Error("the fixture built an invalid record: " + value.message);
    }
    return value;
}

/**
 * The source's single materialized leaf, which its own projection publishes with
 * the occurrence state the reset theorem compares against.
 *
 * @param {object} [options]
 * @param {string} [options.identifier]
 * @param {string} [options.payload]
 * @param {string} [options.createdAt]
 * @param {string} [options.modifiedAt]
 */
function sourceLeaf(options) {
    const settings = options === undefined ? {} : options;
    const record = made(makeValueEvent(
        {
            id: WRITER_PEER + ":1",
            context: contextOf([]),
            authorityTime: authorityOf(10),
            node: NODE_A,
        },
        settings.identifier === undefined ? IDENTIFIER : settings.identifier,
        settings.payload === undefined ? PAYLOAD : settings.payload,
        settings.createdAt === undefined ? NOW : settings.createdAt,
        settings.modifiedAt === undefined ? LATER : settings.modifiedAt,
        "compute"
    ));
    const journal = makeReplicaSource(made(makeJournalReplica([[WRITER_PEER, [record]]])));
    const projection = projectRetainedJournal({
        source: journal,
        localWriter: PEER_AUTHOR,
        currentInputKeysOfNode: () => [],
    });
    if (projection instanceof Error) {
        throw new Error("the source fixture does not project: " + projection.message);
    }
    return makeResetSource({
        databaseVersion: "v1",
        graphSchemeString: "scheme",
        journal,
        projection,
    });
}

/**
 * A reset of an empty receiver to `source`.
 *
 * @param {import("../src/generators/incremental_graph/journal_reset").ResetSource} source
 */
function resetTo(source) {
    const receiver = makeReplicaSource(made(makeJournalReplica([])));
    const built = buildRetainedReplayState({
        source: receiver,
        localWriter: LOCAL_AUTHOR,
        currentInputKeysOfNode: () => [],
    });
    if ("error" in built) {
        throw new Error("the receiver fixture has no retained replay state: " + built.error.message);
    }
    return resetToSource({
        receiver,
        retainedState: built.state,
        source,
        localWriter: LOCAL_AUTHOR,
        committed: {
            localWriter: LOCAL_AUTHOR,
            writerHead: makeJournalSequence("0"),
            committedFrontier: contextOf([]),
            authorityHighWater: authorityOf(100),
            allocatorWatermark: 0,
        },
        observedHighWater: authorityOf(100),
        publicationInstant: INSTANT,
        currentInputKeysOfNode: () => [],
        receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
    });
}

/**
 * @param {ReturnType<typeof resetTo>} result
 * @returns {import("../src/generators/incremental_graph/journal").JournalError}
 */
function errorOf(result) {
    if ("outcome" in result) {
        throw new Error("the reset succeeded, so the committed result was not checked");
    }
    return result.error;
}

beforeEach(() => {
    mockPerturbOccurrence = (occurrence) => occurrence;
});

afterEach(() => {
    mockPerturbOccurrence = (occurrence) => occurrence;
});

describe("resetToSource, the committed result against the target occurrence state", () => {
    test("a committed result which carries the target occurrence state is accepted", () => {
        const result = resetTo(sourceLeaf());

        expect("outcome" in result).toBe(true);
        if (!("outcome" in result)) {
            return;
        }
        expect(isResetOutcome(result.outcome)).toBe(true);
        const occurrence = result.outcome.projection.occurrences.find(
            (candidate) => candidate.nodeKeyString === KEY_A
        );
        expect(occurrence === undefined ? undefined : occurrence.payload).toEqual(PAYLOAD);
    });

    test("a committed payload which is not the target's is refused", () => {
        mockPerturbOccurrence = (occurrence) =>
            occurrence.nodeKeyString === KEY_A
                ? { ...occurrence, payload: OTHER_PAYLOAD }
                : occurrence;

        const error = errorOf(resetTo(sourceLeaf()));

        expect(error.message).toContain("payload is not the target's");
        expect(error.nodeKeyString).toBe(KEY_A);
    });

    test("a committed node identifier which is not the target's is refused", () => {
        mockPerturbOccurrence = (occurrence) =>
            occurrence.nodeKeyString === KEY_A
                ? {
                      ...occurrence,
                      nodeIdentifier: nodeIdentifierFromString(OTHER_IDENTIFIER),
                  }
                : occurrence;

        const error = errorOf(resetTo(sourceLeaf()));

        expect(error.message).toContain("node identifier is not the target's");
        expect(error.nodeKeyString).toBe(KEY_A);
    });

    test("a committed createdAt which is not the target's is refused", () => {
        mockPerturbOccurrence = (occurrence) =>
            occurrence.nodeKeyString === KEY_A
                ? { ...occurrence, createdAt: "2019-01-01T00:00:00.000Z" }
                : occurrence;

        const error = errorOf(resetTo(sourceLeaf()));

        expect(error.message).toContain("createdAt is not the target's");
        expect(error.nodeKeyString).toBe(KEY_A);
    });

    test("a committed modifiedAt which is not the target's is refused", () => {
        mockPerturbOccurrence = (occurrence) =>
            occurrence.nodeKeyString === KEY_A
                ? { ...occurrence, modifiedAt: "2019-01-01T00:00:00.000Z" }
                : occurrence;

        const error = errorOf(resetTo(sourceLeaf()));

        expect(error.message).toContain("modifiedAt is not the target's");
        expect(error.nodeKeyString).toBe(KEY_A);
    });
});
