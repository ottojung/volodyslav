/**
 * Same-ID evidence on the foreign-writer import path.
 *
 * `incremental-graph-journal-sync.md` §Immutable overlap law makes shared-prefix
 * identity a supported-lifecycle theorem, so the acquisition reads the source's
 * missing suffix and never the coordinates the receiver already retains, while
 * requiring same-ID disagreement to be rejected as `JournalForkError` whenever it
 * is actually encountered rather than repaired.
 *
 * The fixtures here build the two inputs as plain `JournalSource` objects rather
 * than as replicas, because the case under test is a source which offers a
 * coordinate the receiver also retains, which no well-formed held snapshot
 * produces and which a replica fixture could therefore not express.
 */

const {
    isJournalForkError,
    journalAuthorToString,
    journalRecordIdToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeValueEvent,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const { planForeignSuffixImport } = require("../src/generators/incremental_graph/journal_sync");

const NODE_A = { head: "event", args: [{ id: 1 }] };
const NODE_B = { head: "event", args: [{ id: 2 }] };
const NODE_C = { head: "event", args: [{ id: 3 }] };
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const LOCAL_AUTHOR = makeJournalAuthor(WRITER_LOCAL);
const PAYLOAD = { type: "entry_description", description: "x" };
const OTHER_PAYLOAD = { type: "entry_description", description: "y" };

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
 * @param {object} record
 * @param {string} record.writer
 * @param {string} record.sequence
 * @param {ReadonlyArray<string>} record.context - The writer-local coordinates the
 *   record observed, before its own coordinate.
 * @param {import("../src/generators/incremental_graph/journal").NodeKey} record.node
 * @param {object} [record.payload]
 */
function valueOf(record) {
    return made(makeValueEvent(
        {
            id: record.writer + ":" + record.sequence,
            context: makeJournalFrontierFromText([
                ...record.context,
                [record.writer, String(Number(record.sequence) - 1)],
            ].filter((entry) => entry[1] !== "0")),
            authorityTime: authorityOf(Number(record.sequence)),
            node: record.node,
        },
        nodeKeyToCanonicalString(record.node) === nodeKeyToCanonicalString(NODE_A)
            ? "1-abcdefghi"
            : nodeKeyToCanonicalString(record.node) === nodeKeyToCanonicalString(NODE_B)
                ? "2-abcdefghi"
                : "3-abcdefghi",
        record.payload === undefined ? PAYLOAD : record.payload,
        NOW,
        LATER,
        "compute"
    ));
}

/**
 * One writer's retained stream as a `JournalSource` offers it: a pull reader over
 * the records in writer-stream order plus the retained length the source declares.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {import("../src/generators/incremental_graph/journal").JournalSource}
 */
function sourceOf(records) {
    /** @type {Map<string, ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>>} */
    const streams = new Map();
    for (const record of records) {
        const name = journalAuthorToString(record.id.author);
        streams.set(name, [...(streams.get(name) ?? []), record]);
    }
    return {
        writers: () => [...streams.keys()].map((name) => makeJournalAuthor(name)),
        retainedLengthOf: (author) => {
            const stream = streams.get(journalAuthorToString(author));
            if (stream === undefined || stream.length === 0) {
                return undefined;
            }
            return stream[stream.length - 1].id.sequence;
        },
        prefixReaderOf: (author) => {
            const stream = streams.get(journalAuthorToString(author)) ?? [];
            let position = 0;
            return {
                nextRecord: () => stream[position++],
                failure: () => undefined,
            };
        },
    };
}

/**
 * @param {import("../src/generators/incremental_graph/journal").JournalSource} receiver
 * @param {import("../src/generators/incremental_graph/journal").JournalSource} source
 */
function plan(receiver, source) {
    return planForeignSuffixImport({
        receiver,
        source,
        localWriter: LOCAL_AUTHOR,
        currentInputKeysOfNode: () => [],
    });
}

/**
 * @param {ReturnType<typeof plan>} result
 * @returns {import("../src/generators/incremental_graph/journal").JournalError}
 */
function errorOf(result) {
    if (!("error" in result)) {
        throw new Error("the import plan succeeded, so no same-ID disagreement was reported");
    }
    return result.error;
}

/** The peer records the receiver and the source both hold, plus the one the source adds. */
function peerA() {
    return valueOf({ writer: WRITER_PEER, sequence: "1", context: [], node: NODE_A });
}

function peerB() {
    return valueOf({ writer: WRITER_PEER, sequence: "2", context: [], node: NODE_B });
}

function peerC() {
    return valueOf({ writer: WRITER_PEER, sequence: "3", context: [], node: NODE_C });
}

describe("planForeignSuffixImport, the same-ID evidence a source offers", () => {
    test("a source which opens above the receiver's retained length imports only its own suffix", () => {
        const result = plan(
            sourceOf([peerA(), peerB()]),
            sourceOf([peerA(), peerB(), peerC()])
        );

        if (!("suffixes" in result)) {
            throw new Error("the import failed with " + result.error.name + ": " + result.error.message);
        }
        expect(result.suffixes.flatMap((suffix) => suffix.records.map(
            (record) => journalRecordIdToString(record.id)
        ))).toEqual([WRITER_PEER + ":3"]);
    });

    test("a source which re-offers the receiver's own records with the same meaning imports nothing extra", () => {
        const result = plan(
            sourceOf([peerA(), peerB()]),
            sourceOf([peerA(), peerB()])
        );

        expect("suffixes" in result).toBe(true);
    });

    test("a source which re-offers a retained coordinate with a different meaning is refused as a writer fork", () => {
        const forked = valueOf({
            writer: WRITER_PEER,
            sequence: "1",
            context: [],
            node: NODE_A,
            payload: OTHER_PAYLOAD,
        });

        const error = errorOf(plan(sourceOf([peerA(), peerB()]), sourceOf([forked, peerB(), peerC()])));

        expect(isJournalForkError(error)).toBe(true);
        expect(error.recordId).toBe(WRITER_PEER + ":1");
        expect(error.firstMeaning).not.toBe(error.secondMeaning);
    });

    test("a fork in a retained coordinate is refused before the imported suffix is admitted", () => {
        const forked = valueOf({
            writer: WRITER_PEER,
            sequence: "2",
            context: [],
            node: NODE_B,
            payload: OTHER_PAYLOAD,
        });

        const error = errorOf(plan(sourceOf([peerA(), peerB()]), sourceOf([peerA(), forked, peerC()])));

        expect(isJournalForkError(error)).toBe(true);
        expect(error.recordId).toBe(WRITER_PEER + ":2");
    });
});
