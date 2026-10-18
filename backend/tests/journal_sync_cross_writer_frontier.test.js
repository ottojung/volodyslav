/**
 * Foreign-writer suffix import validates against the complete union frontier.
 *
 * `incremental-graph-journal-sync.md` §Stable snapshot union defines the union
 * frontier as the receiver joined with every imported suffix, and §Final replay
 * and validation requires each admitted record to be validated against that
 * union. The frontier is therefore independent of the order the suffixes happen
 * to be read in: a record from one imported writer may name a coordinate of
 * another imported writer whose suffix has not been acquired yet.
 *
 * These tests pin the external behaviour of `planForeignSuffixImport`: a source
 * whose cross-writer context reaches a writer that sorts after the referencing
 * writer is accepted, while a context that reaches a coordinate the union does
 * not retain is still rejected.
 */

const {
    isJournalCausalClosureError,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeReplicaSource,
    makeValueEvent,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const {
    isImportPlan,
    planForeignSuffixImport,
} = require("../src/generators/incremental_graph/journal_sync");

const NODE_K = { head: "event", args: [{ id: 1 }] };
const NODE_D = { head: "event", args: [{ id: 2 }] };
const KEY_K = nodeKeyToCanonicalString(NODE_K);
const NOW = "2020-01-01T00:00:00.000Z";
const WRITER_A = "aaaaaaaaa";
const WRITER_B = "bbbbbbbbb";
const WRITER_C = "ccccccccc";

/**
 * The fixture schema: `K` has one direct input, `D`.
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function schema(nodeKeyString) {
    return nodeKeyString === KEY_K ? [nodeKeyToCanonicalString(NODE_D)] : [];
}

/**
 * @param {ReadonlyArray<string>} coordinates
 */
function contextOf(coordinates) {
    return makeJournalFrontierFromText(coordinates);
}

/**
 * @param {string} id
 * @param {ReadonlyArray<string>} coordinates
 * @param {number} physical
 */
function value(id, coordinates, physical) {
    return makeValueEvent(
        {
            id,
            context: contextOf(coordinates),
            authorityTime: makeAuthorityTime(physical, "0"),
            node: NODE_K,
        },
        "1-abcdefghi",
        { type: "entry_description", description: id },
        NOW,
        NOW,
        "compute"
    );
}

/**
 * @param {ReadonlyArray<[string, ReadonlyArray<object>]>} streams
 */
function sourceOf(streams) {
    const replica = makeJournalReplica(streams);
    if (replica instanceof Error) {
        throw new Error("the fixture built an invalid replica: " + replica.message);
    }
    return makeReplicaSource(replica);
}

/**
 * @param {object} source
 * @returns {object}
 */
async function planAgainst(source) {
    return await planForeignSuffixImport({
        receiver: sourceOf([]),
        source,
        localWriter: makeJournalAuthor(WRITER_B),
        currentInputKeysOfNode: schema,
    });
}

describe("planForeignSuffixImport, the complete union frontier", () => {
    test("a record may name a later-sorting imported writer the union will retain", async () => {
        // `A:1` observes `C:1`, and `C` sorts after `A`. The union of the receiver
        // (empty) and both imported suffixes retains `C:1`, so the plan must accept
        // the source rather than reject it because `C` has not been read yet.
        const source = sourceOf([
            [WRITER_A, [value(WRITER_A + ":1", [[WRITER_C, "1"]], 100)]],
            [WRITER_C, [value(WRITER_C + ":1", [], 90)]],
        ]);

        const plan = await planAgainst(source);
        expect(isImportPlan(plan)).toBe(true);
        if (!isImportPlan(plan)) {
            return;
        }
        expect(plan.suffixes.map((suffix) => suffix.author)).toHaveLength(2);
    });

    test("a context coordinate the union does not retain is still rejected", async () => {
        // `A:1` observes `C:5`, but the source retains only `C:1`. Completing the
        // frontier must not turn an out-of-range claim into an accepted one.
        const source = sourceOf([
            [WRITER_A, [value(WRITER_A + ":1", [[WRITER_C, "5"]], 100)]],
            [WRITER_C, [value(WRITER_C + ":1", [], 90)]],
        ]);

        const plan = await planAgainst(source);
        expect("error" in plan).toBe(true);
        if (!("error" in plan)) {
            return;
        }
        expect(isJournalCausalClosureError(plan.error)).toBe(true);
    });
});
