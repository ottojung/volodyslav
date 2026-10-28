/**
 * The retained-prefix/imported-suffix causal-closure boundary.
 *
 * `incremental-graph-journal-sync.md` §Imported causal closure and §Final replay
 * and validation require the contexts of newly admitted records to be
 * transitively closed, including against the retained prefix they claim — not
 * only against the admitted change set. The bounded import path previously
 * skipped every claimed coordinate no admitted maximum covered as a
 * "retained-prefix" coordinate, so a suffix which claimed a retained event
 * while omitting what that event observed was accepted even though
 * whole-history validation rejects it.
 *
 * This test pins the boundary variant: the receiver already retains A:1 and
 * B:1 (where B:1 observes A:1) and the source offers only C:1. The malformed
 * C:1 claims B:1 while omitting A:1; the closed C:1 claims both. The bounded
 * path must reject the former with a `JournalCausalClosureError` and accept
 * the latter, matching `validateJournalReplica` in both directions.
 */

const {
    isJournalCausalClosureError,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeReplicaSource,
    makeValueEvent,
    validateJournalReplica,
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

function retainedPrefix() {
    const a1 = value(WRITER_A, "1", NODE_K, [], 100, "1-abcdefghi");
    const b1 = value(WRITER_B, "1", NODE_X, [[WRITER_A, "1"]], 200, "2-abcdefghi");
    return { a1, b1 };
}

/**
 * C:1 claims the retained B:1 while omitting the A:1 that B:1 observed.
 */
function malformedSuffix() {
    return value(WRITER_C, "1", NODE_Y, [[WRITER_B, "1"], [WRITER_A, "0"]], 300, "3-abcdefghi");
}

/**
 * C:1 claims the retained B:1 and the A:1 that B:1 observed.
 */
function closedSuffix() {
    return value(WRITER_C, "1", NODE_Y, [[WRITER_B, "1"], [WRITER_A, "1"]], 300, "3-abcdefghi");
}

/**
 * @param {{a1: object, b1: object}} prefix
 * @param {object} c1
 */
async function planOf(prefix, c1) {
    const { a1, b1 } = prefix;
    return await planForeignSuffixImport({
        receiver: makeReplicaSource(makeJournalReplica([
            [makeJournalAuthor(WRITER_A), [a1]],
            [makeJournalAuthor(WRITER_B), [b1]],
        ])),
        source: makeReplicaSource(makeJournalReplica([
            [makeJournalAuthor(WRITER_A), [a1]],
            [makeJournalAuthor(WRITER_B), [b1]],
            [makeJournalAuthor(WRITER_C), [c1]],
        ])),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        currentInputKeysOfNode: () => [],
    });
}

describe("the bounded import path's retained-prefix causal-closure boundary", () => {
    test("whole-history validation rejects the retained-prefix/imported-suffix malformation", () => {
        const { a1, b1 } = retainedPrefix();
        const failure = validateJournalReplica(makeJournalReplica([
            [makeJournalAuthor(WRITER_A), [a1]],
            [makeJournalAuthor(WRITER_B), [b1]],
            [makeJournalAuthor(WRITER_C), [malformedSuffix()]],
        ]));
        expect(isJournalCausalClosureError(failure)).toBe(true);
    });

    test("the bounded import path rejects the malformed suffix claimed against the retained prefix", async () => {
        const plan = await planOf(retainedPrefix(), malformedSuffix());
        expect("error" in plan).toBe(true);
        if (!("error" in plan)) {
            throw new Error("expected the malformed retained-prefix claim to be rejected");
        }
        expect(isJournalCausalClosureError(plan.error)).toBe(true);
    });

    test("the bounded import path accepts the closed suffix claimed against the retained prefix", async () => {
        const plan = await planOf(retainedPrefix(), closedSuffix());
        expect("error" in plan).toBe(false);
    });

    test("whole-history validation accepts the closed retained-prefix/imported-suffix union", () => {
        const { a1, b1 } = retainedPrefix();
        expect(validateJournalReplica(makeJournalReplica([
            [makeJournalAuthor(WRITER_A), [a1]],
            [makeJournalAuthor(WRITER_B), [b1]],
            [makeJournalAuthor(WRITER_C), [closedSuffix()]],
        ]))).toBeUndefined();
    });
});
