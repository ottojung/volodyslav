/**
 * The bounded import path checks transitive closure and authority extension over the
 * admitted change set.
 *
 * `incremental-graph-journal-sync.md` §Final replay and validation requires contexts of
 * newly admitted records to be transitively closed and their authority to extend
 * happened-before. Both are relations between a record and every event it claims to have
 * observed, so the bounded path evaluates them over the complete set of records one
 * operation admits rather than as each suffix is read. These tests pin the rejection of
 * an unclosed context and of a non-extending authority, and the acceptance of the
 * well-formed counterpart.
 */

const {
    isJournalCausalClosureError,
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
    return makeReplicaSource(makeJournalReplica(
        streams.map(([writer, records]) => [makeJournalAuthor(writer), records])
    ));
}

/**
 * @param {ReadonlyArray<[string, ReadonlyArray<object>]>} streams
 */
function planOf(streams) {
    return planForeignSuffixImport({
        receiver: makeReplicaSource(makeJournalReplica([])),
        source: sourceOf(streams),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        currentInputKeysOfNode: () => [],
    });
}

describe("the bounded import path checks admitted closure and authority", () => {
    test("an unclosed admitted context is rejected", () => {
        const a1 = value(WRITER_A, "1", NODE_K, [], 100, "1-abcdefghi");
        const b1 = value(WRITER_B, "1", NODE_X, [[WRITER_A, "1"]], 200, "2-abcdefghi");
        const c1 = value(WRITER_C, "1", NODE_Y, [[WRITER_B, "1"], [WRITER_A, "0"]], 300, "3-abcdefghi");
        const plan = planOf([
            [WRITER_A, [a1]],
            [WRITER_B, [b1]],
            [WRITER_C, [c1]],
        ]);
        expect("error" in plan).toBe(true);
        if (!("error" in plan)) {
            throw new Error("expected the unclosed admitted context to be rejected");
        }
        expect(isJournalCausalClosureError(plan.error)).toBe(true);
    });

    test("an admitted record whose authority does not extend an observed predecessor is rejected", () => {
        const a1 = value(WRITER_A, "1", NODE_K, [], 100, "1-abcdefghi");
        const b1 = value(WRITER_B, "1", NODE_X, [[WRITER_A, "1"]], 300, "2-abcdefghi");
        const c1 = value(WRITER_C, "1", NODE_Y, [[WRITER_B, "1"], [WRITER_A, "1"]], 200, "3-abcdefghi");
        const plan = planOf([
            [WRITER_A, [a1]],
            [WRITER_B, [b1]],
            [WRITER_C, [c1]],
        ]);
        expect("error" in plan).toBe(true);
        if (!("error" in plan)) {
            throw new Error("expected the non-extending authority to be rejected");
        }
        expect(isJournalCausalClosureError(plan.error)).toBe(true);
    });

    test("a closed, authority-extending admitted history is accepted", () => {
        const a1 = value(WRITER_A, "1", NODE_K, [], 100, "1-abcdefghi");
        const b1 = value(WRITER_B, "1", NODE_X, [[WRITER_A, "1"]], 200, "2-abcdefghi");
        const c1 = value(WRITER_C, "1", NODE_Y, [[WRITER_B, "1"], [WRITER_A, "1"]], 300, "3-abcdefghi");
        const plan = planOf([
            [WRITER_A, [a1]],
            [WRITER_B, [b1]],
            [WRITER_C, [c1]],
        ]);
        expect("error" in plan).toBe(false);
    });

    test("a claim on a coordinate retained outside the change set is not rescanned", () => {
        // The receiver retains A:1; the source imports B:1, whose context claims A:1.
        // The retained A:1 is not part of the change set, so its context is not read
        // here and the import succeeds.
        const a1 = value(WRITER_A, "1", NODE_K, [], 100, "1-abcdefghi");
        const b1 = value(WRITER_B, "1", NODE_X, [[WRITER_A, "1"]], 200, "2-abcdefghi");
        const plan = planForeignSuffixImport({
            receiver: sourceOf([[WRITER_A, [a1]]]),
            source: sourceOf([[WRITER_B, [b1]]]),
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            currentInputKeysOfNode: () => [],
        });
        expect("error" in plan).toBe(false);
    });
});
