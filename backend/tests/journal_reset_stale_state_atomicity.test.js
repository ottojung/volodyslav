/**
 * `incremental-graph-journal-reset.md` §Streamability and §Atomicity, exercised
 * through the production `resetToSource`.
 *
 * Two derived-state contracts synchronization already honours and reset must
 * honour too:
 *
 * - §Streamability requires a missing or stale counted proof summary to be refused
 *   rather than consumed, as `incremental-graph-journal-storage.md` §Change-bounded
 *   proof summary states. A retained replay state built for another local writer, or
 *   for a different per-writer length set, must not be staged into.
 * - §Atomicity requires a failure before cutover to leave the previous supported
 *   receiver active, including its in-memory derived state: a failed reset must not
 *   leave the caller's retained state describing records it never committed.
 *
 * Every fixture is a supported graph plus Journal pair: each record is written by a
 * writer which observed the coordinates it references.
 */

const {
    journalAuthorToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeJournalSequence,
    makeReplicaSource,
    makeValueEvent,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal");

const { SnapshotIdentityClass } = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
    makeResetSource,
    resetToSource,
} = require("../src/generators/incremental_graph/journal_reset");

const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const LOCAL_AUTHOR = makeJournalAuthor(WRITER_LOCAL);
const PEER_AUTHOR = makeJournalAuthor(WRITER_PEER);
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const PAYLOAD = { type: "entry_description", description: "x" };
const NODE_A = { head: "event", args: [{ id: 1 }] };
const NODE_B = { head: "event", args: [{ id: 2 }] };
const INSTANT = 1700000000000;

/**
 * @template T
 * @param {T | Error} value
 * @returns {T}
 */
function made(value) {
    if (value instanceof Error) {
        throw value;
    }
    return value;
}

/**
 * @param {string} writer
 * @param {string} sequence
 * @param {object} node
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
 */
function valueOf(writer, sequence, node) {
    return made(
        makeValueEvent(
            {
                id: writer + ":" + sequence,
                context: makeJournalFrontierFromText(
                    Number(sequence) > 1 ? [[writer, String(Number(sequence) - 1)]] : []
                ),
                authorityTime: makeAuthorityTime(Number(sequence), "0"),
                node,
            },
            String(node.args[0].id) + "-abcdefghi",
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        )
    );
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {import("../src/generators/incremental_graph/journal").JournalSource}
 */
function sourceOf(records) {
    const byWriter = new Map();
    for (const record of records) {
        const writer = journalAuthorToString(record.id.author);
        byWriter.set(writer, [...(byWriter.get(writer) || []), record]);
    }
    return makeReplicaSource(made(makeJournalReplica([...byWriter.entries()])));
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {Promise<import("../src/generators/incremental_graph/journal_reset").ResetSource>}
 */
async function resetSourceOf(records) {
    const journal = sourceOf(records);
    const projection = await projectRetainedJournal({
        source: journal,
        localWriter: PEER_AUTHOR,
        currentInputKeysOfNode: () => [],
    });
    if (projection instanceof Error) {
        throw projection;
    }
    return makeResetSource({
        databaseVersion: "v1",
        graphSchemeString: "scheme",
        journal,
        projection,
    });
}

/**
 * @param {import("../src/generators/incremental_graph/journal").JournalSource} source
 * @returns {Promise<import("../src/generators/incremental_graph/journal_reset").RetainedReplayState>}
 */
async function retainedStateOf(source) {
    const built = await buildRetainedReplayState({
        source,
        localWriter: LOCAL_AUTHOR,
        currentInputKeysOfNode: () => [],
    });
    if ("error" in built) {
        throw built.error;
    }
    return built.state;
}

/**
 * @param {string} sequence
 * @returns {object}
 */
function committedWithHead(sequence) {
    return {
        localWriter: LOCAL_AUTHOR,
        writerHead: makeJournalSequence(sequence),
        committedFrontier: makeJournalFrontierFromText(
            sequence === "0" ? [] : [[WRITER_LOCAL, sequence]]
        ),
        authorityHighWater: makeAuthorityTime(500, "0"),
        allocatorWatermark: 0,
    };
}

/**
 * A stable serialization of the state a caller could observe was mutated.
 *
 * @param {import("../src/generators/incremental_graph/journal_reset").RetainedReplayState} state
 * @returns {string}
 */
function describeState(state) {
    return JSON.stringify(
        [...state.admittedLengths.entries()].map(([writer, length]) => [writer, String(length)])
    );
}

describe("reset refuses a retained state that does not describe the receiver", () => {
    test("a state built for another receiver is refused instead of staged into", async () => {
        // A state built for a receiver which retains its own local `A` occurrence.
        const staleState = await retainedStateOf(sourceOf([valueOf(WRITER_LOCAL, "1", NODE_A)]));
        // The actual receiver is empty and retains nothing.
        const receiver = sourceOf([]);
        const source = await resetSourceOf([valueOf(WRITER_PEER, "1", NODE_B)]);

        const result = await resetToSource({
            receiver,
            retainedState: staleState,
            source,
            localWriter: LOCAL_AUTHOR,
            committed: committedWithHead("0"),
            observedHighWater: makeAuthorityTime(500, "0"),
            publicationInstant: INSTANT,
            currentInputKeysOfNode: () => [],
            receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
        });

        expect("error" in result).toBe(true);
    });
});

describe("a failed reset leaves the caller's retained state untouched", () => {
    test("a failure after imported records are staged does not mutate the caller's state", async () => {
        const receiver = sourceOf([valueOf(WRITER_LOCAL, "1", NODE_A)]);
        const state = await retainedStateOf(receiver);
        const before = describeState(state);
        const source = await resetSourceOf([valueOf(WRITER_PEER, "1", NODE_A)]);

        const result = await resetToSource({
            receiver,
            retainedState: state,
            source,
            localWriter: LOCAL_AUTHOR,
            committed: committedWithHead("1"),
            observedHighWater: makeAuthorityTime(500, "0"),
            // A negative instant forces Pass 1 allocation to fail after the import
            // has already been staged into the state.
            publicationInstant: -1,
            currentInputKeysOfNode: () => [],
            receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
        });

        expect("error" in result).toBe(true);
        expect(describeState(state)).toBe(before);
    });
});
