/**
 * The foreign-writer import path streams each missing suffix instead of
 * materialising it.
 *
 * `incremental-graph-journal-sync.md` §Streamability and
 * `$id-4924739474925738` require the complete newly transferred suffix to be
 * consumable incrementally rather than held as one in-RAM collection. The plan
 * `planForeignSuffixImport` returns is therefore a set of positioned, re-readable
 * readers over the held source, not arrays of admitted records: each
 * `ImportedSuffix` carries the range `(FR[A]+1) .. FS[A]` and reproduces it on
 * demand, and the relation-shaped validation re-reads the change set against a
 * complete admitted-relations index instead of an admitted-records array.
 *
 * These tests pin three things. The plan exposes no materialised suffix and its
 * readers reproduce the exact range, twice. The suffix is read through a
 * positioned reader at the first missing coordinate rather than by reading the
 * retained prefix and discarding it. And the transitive-closure and authority
 * checks are evaluated against the complete change set, so a record read before
 * the writer it claims is still rejected.
 */

const {
    isJournalCausalClosureError,
    journalRecordIdToString,
    journalSequenceToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeReplicaSource,
    makeValueEvent,
} = require("../src/generators/incremental_graph/journal");

const {
    planForeignSuffixImport,
} = require("../src/generators/incremental_graph/journal_sync");

const WRITER_LOCAL = "zzzzzzzzz";
const WRITER_A = "aaaaaaaaa";
const WRITER_B = "bbbbbbbbb";
const WRITER_C = "ccccccccc";

const NODE_K = { head: "event", args: [{ id: 1 }] };
const NODE_X = { head: "event", args: [{ id: 2 }] };
const NODE_Y = { head: "event", args: [{ id: 3 }] };

const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";

/**
 * @param {unknown} value
 * @returns {any}
 */
function made(value) {
    if (value instanceof Error) {
        throw new Error("the fixture built an invalid record: " + value.message);
    }
    return value;
}

/**
 * @param {string} writer
 * @param {string} sequence
 * @param {object} node
 * @param {ReadonlyArray<[string, string]>} context
 * @param {number} physical
 * @param {string} identifier
 */
function value(writer, sequence, node, context, physical, identifier) {
    return made(makeValueEvent(
        {
            id: writer + ":" + sequence,
            context: makeJournalFrontierFromText(context),
            authorityTime: makeAuthorityTime(physical, "0"),
            node,
        },
        identifier,
        { type: "entry_description", description: "v" + sequence },
        NOW,
        LATER,
        "compute"
    ));
}

/**
 * @param {ReadonlyArray<[string, ReadonlyArray<object>]>} streams
 */
function sourceOf(streams) {
    return makeReplicaSource(makeJournalReplica(streams));
}

/**
 * @param {ReadonlyArray<[string, ReadonlyArray<object>]>} streams
 */
async function planOf(streams) {
    return await planForeignSuffixImport({
        receiver: makeReplicaSource(makeJournalReplica([])),
        source: sourceOf(streams),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        currentInputKeysOfNode: () => [],
    });
}

/**
 * Every coordinate one suffix reader yields.
 *
 * @param {import("../src/generators/incremental_graph/journal_sync").ImportedSuffix} suffix
 * @returns {Promise<ReadonlyArray<string>>}
 */
async function readIds(suffix) {
    /** @type {Array<string>} */
    const ids = [];
    const reader = suffix.reader();
    for (;;) {
        const record = await reader.nextRecord();
        if (record === undefined) {
            break;
        }
        ids.push(journalRecordIdToString(record.id));
    }
    return ids;
}

/**
 * A source which records the coordinates a consumer asks its positioned readers
 * for and the coordinates its whole-prefix readers yield.
 *
 * @param {object} source
 * @returns {object}
 */
function recordingSource(source) {
    /** @type {Array<string>} */
    const suffixFroms = [];
    /** @type {Array<string>} */
    const prefixReads = [];
    return {
        writers: () => source.writers(),
        retainedLengthOf: (author) => source.retainedLengthOf(author),
        prefixReaderOf: (author) => {
            const reader = source.prefixReaderOf(author);
            return {
                nextRecord: async () => {
                    const record = await reader.nextRecord();
                    if (record !== undefined) {
                        prefixReads.push(journalRecordIdToString(record.id));
                    }
                    return record;
                },
                failure: () => reader.failure(),
            };
        },
        suffixReaderOf: (author, fromSequence) => {
            suffixFroms.push(journalSequenceToString(fromSequence));
            return source.suffixReaderOf(author, fromSequence);
        },
        suffixFroms: () => suffixFroms,
        prefixReads: () => prefixReads,
    };
}

describe("planForeignSuffixImport, the missing suffix it streams", () => {
    test("the plan carries no materialised suffix and its reader reproduces the range", async () => {
        const plan = await planOf([
            [WRITER_A, [value(WRITER_A, "1", NODE_K, [], 100, "1-abcdefghi")]],
        ]);
        expect("error" in plan).toBe(false);
        if (!("suffixes" in plan)) {
            throw new Error("the import plan failed unexpectedly");
        }
        expect(plan.suffixes).toHaveLength(1);
        const suffix = plan.suffixes[0];
        // The plan holds the range, not the records.
        expect(suffix.records).toBeUndefined();
        expect(journalSequenceToString(suffix.from)).toBe("1");
        expect(journalSequenceToString(suffix.to)).toBe("1");
        // The reader is a fresh traversal each time, and it reproduces the range.
        expect(await readIds(suffix)).toEqual([WRITER_A + ":1"]);
        expect(await readIds(suffix)).toEqual([WRITER_A + ":1"]);
    });

    test("a suffix is read at the first missing coordinate, not by scanning the retained prefix", async () => {
        // The receiver retains `A:1`; the source offers `A:1 .. A:3`, so the
        // imported range is `A:2 .. A:3`.
        const receiver = sourceOf([
            [WRITER_A, [value(WRITER_A, "1", NODE_K, [], 100, "1-abcdefghi")]],
        ]);
        const source = recordingSource(sourceOf([
            [
                WRITER_A,
                [
                    value(WRITER_A, "1", NODE_K, [], 100, "1-abcdefghi"),
                    value(WRITER_A, "2", NODE_K, [[WRITER_A, "1"]], 110, "1-abcdefghi"),
                    value(WRITER_A, "3", NODE_K, [[WRITER_A, "2"]], 120, "1-abcdefghi"),
                ],
            ],
        ]));
        const plan = await planForeignSuffixImport({
            receiver,
            source,
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            currentInputKeysOfNode: () => [],
        });
        expect("error" in plan).toBe(false);

        // Every read opens at the first missing coordinate, including the seam
        // check, so the retained prefix `A:1` is never read: the whole-prefix
        // reader yields nothing at all. `incremental-graph-journal-sync.md`
        // §Immutable overlap law requires exactly this — ordinary synchronization
        // does not rescan the complete retained overlap.
        expect(source.suffixFroms().length).toBeGreaterThan(0);
        expect(new Set(source.suffixFroms())).toEqual(new Set(["2"]));
        expect(source.prefixReads()).toEqual([]);
    });

    test("the seam does not rescan a long retained overlap", async () => {
        // The receiver retains `A:1 .. A:N`; the source retains `A:1 .. A:N+1`.
        // The seam must compare no retained coordinate and the receiver's retained
        // journal must not be opened at all, so the plan's read cost is independent
        // of N. `incremental-graph-journal-sync.md` §Immutable overlap law and the
        // change-bounded contract `$id-6845129073418625` require this; an
        // O(overlap) seam would make `source.prefixReads()` and
        // `receiver.prefixReads()` grow with N.
        const n = 200;
        /** @type {Array<object>} */
        const retained = [];
        /** @type {Array<object>} */
        const extended = [];
        for (let i = 1; i <= n + 1; i += 1) {
            const context = i === 1 ? [] : [[WRITER_A, String(i - 1)]];
            const record = value(WRITER_A, String(i), NODE_K, context, 100 + i, "1-abcdefghi");
            extended.push(record);
            if (i <= n) {
                retained.push(record);
            }
        }
        const receiver = recordingSource(sourceOf([[WRITER_A, retained]]));
        const source = recordingSource(sourceOf([[WRITER_A, extended]]));

        const plan = await planForeignSuffixImport({
            receiver,
            source,
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            currentInputKeysOfNode: () => [],
        });
        expect("error" in plan).toBe(false);
        if (!("suffixes" in plan)) {
            throw new Error("the import plan failed unexpectedly");
        }
        expect(journalSequenceToString(plan.suffixes[0].from)).toBe(String(n + 1));
        expect(source.prefixReads()).toEqual([]);
        expect(receiver.prefixReads()).toEqual([]);
    });
});

describe("planForeignSuffixImport, the relations it checks over the complete change set", () => {
    test("a closure omission on a record read before the writer it claims is rejected", async () => {
        // `A:1` is read first and claims `B:1`, whose own context claims `C:1`.
        // `A:1` omits `C:1`, so its context is not transitively closed. A check
        // against the acquisition-order prefix would not see `B:1` yet.
        const plan = await planOf([
            [WRITER_A, [value(WRITER_A, "1", NODE_K, [[WRITER_B, "1"]], 300, "1-abcdefghi")]],
            [WRITER_B, [value(WRITER_B, "1", NODE_X, [[WRITER_C, "1"]], 200, "2-abcdefghi")]],
            [WRITER_C, [value(WRITER_C, "1", NODE_Y, [], 100, "3-abcdefghi")]],
        ]);
        expect("error" in plan).toBe(true);
        if (!("error" in plan)) {
            throw new Error("expected the unclosed forward claim to be rejected");
        }
        expect(isJournalCausalClosureError(plan.error)).toBe(true);
    });

    test("a non-extending authority on a record read before the writer it claims is rejected", async () => {
        // `A:1` is read first and claims `B:1`, whose authority is greater.
        const plan = await planOf([
            [WRITER_A, [value(WRITER_A, "1", NODE_K, [[WRITER_B, "1"]], 100, "1-abcdefghi")]],
            [WRITER_B, [value(WRITER_B, "1", NODE_X, [], 200, "2-abcdefghi")]],
        ]);
        expect("error" in plan).toBe(true);
        if (!("error" in plan)) {
            throw new Error("expected the non-extending forward authority to be rejected");
        }
        expect(isJournalCausalClosureError(plan.error)).toBe(true);
    });
});
