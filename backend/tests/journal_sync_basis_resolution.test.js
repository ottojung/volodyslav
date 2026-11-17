/**
 * The bounded import path resolves a validation basis entry to a ValueEvent of the
 * exact input node it names.
 *
 * `incremental-graph-journal-well-formedness.md` section Validation basis rules requires
 * each non-`"unknown"` basis value to name a retained ValueEvent for that exact input
 * NodeKey, and section Imported-record validation requires the receiver to validate those
 * rules on newly admitted records. A source record whose basis names a ValueEvent of a
 * different node is therefore corrupt and must be refused on the bounded path.
 */

const {
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeReplicaSource,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const {
    planForeignSuffixImport,
} = require("../src/generators/incremental_graph/journal_sync");

const WRITER_LOCAL = "zzzzzzzzz";
const WRITER_A = "aaaaaaaaa";
const WRITER_C = "ccccccccc";

const NODE_K = { head: "event", args: [{ id: 1 }] };
const NODE_D = { head: "event", args: [{ id: 2 }] };
const NODE_X = { head: "event", args: [{ id: 3 }] };

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
 * @param {string} writer
 * @param {string} sequence
 * @param {object} node
 * @param {object} target
 * @param {ReadonlyArray<object>} basis
 * @param {ReadonlyArray<[string, string]>} context
 * @param {number} physical
 */
function validate(writer, sequence, node, target, basis, context, physical) {
    return made(makeValidateEvent(
        {
            id: writer + ":" + sequence,
            context: makeJournalFrontierFromText(context),
            authorityTime: makeAuthorityTime(physical, "0"),
            node,
        },
        target.id,
        basis,
        "compute"
    ));
}

/**
 * The current schema this test supplies: `K`'s one direct input is `D`.
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function currentInputKeysOfNode(nodeKeyString) {
    if (nodeKeyString === nodeKeyToCanonicalString(NODE_K)) {
        return [nodeKeyToCanonicalString(NODE_D)];
    }
    return [];
}

/**
 * @param {ReadonlyArray<[string, ReadonlyArray<object>]>} streams
 */
function sourceOf(streams) {
    return makeReplicaSource(makeJournalReplica(
        streams.map(([writer, records]) => [makeJournalAuthor(writer), records])
    ));
}

describe("the bounded import path resolves admitted validation basis values", () => {
    test("a basis value naming a ValueEvent of another node is rejected", async () => {
        // A:1 is a ValueEvent of NODE_X, but K's basis claims it is the occurrence of
        // K's input NODE_D. Whole-history well-formedness rejects this as a wrong-node
        // reference; the bounded import path must reject it too.
        const a1 = value(WRITER_A, "1", NODE_X, [], 100, "1-abcdefghi");
        const a2 = value(WRITER_A, "2", NODE_K, [[WRITER_A, "1"]], 200, "2-abcdefghi");
        const c1 = validate(
            WRITER_C,
            "1",
            NODE_K,
            a2,
            [made(makeValidationBasisEntry(NODE_D, a1.id))],
            [[WRITER_A, "2"]],
            300
        );
        const plan = await planForeignSuffixImport({
            receiver: sourceOf([]),
            source: sourceOf([
                [WRITER_A, [a1, a2]],
                [WRITER_C, [c1]],
            ]),
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            currentInputKeysOfNode,
        });
        expect("error" in plan).toBe(true);
    });

    test("a basis value naming the exact input node's ValueEvent is accepted", async () => {
        const a1 = value(WRITER_A, "1", NODE_D, [], 100, "1-abcdefghi");
        const a2 = value(WRITER_A, "2", NODE_K, [[WRITER_A, "1"]], 200, "2-abcdefghi");
        const c1 = validate(
            WRITER_C,
            "1",
            NODE_K,
            a2,
            [made(makeValidationBasisEntry(NODE_D, a1.id))],
            [[WRITER_A, "2"]],
            300
        );
        const plan = await planForeignSuffixImport({
            receiver: sourceOf([]),
            source: sourceOf([
                [WRITER_A, [a1, a2]],
                [WRITER_C, [c1]],
            ]),
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            currentInputKeysOfNode,
        });
        expect("error" in plan).toBe(false);
    });

    test("a basis value the record's context does not cover is rejected", async () => {
        // A:3 is a later NODE_D ValueEvent; C:1 names it as K's input but its context
        // only reaches A:2, so A:3 did not happen-before C:1. Well-formedness section
        // Validation basis rules item 5 rejects the non-causal input; the bounded path
        // must too, even though A:3 is the right node's ValueEvent.
        const a1 = value(WRITER_A, "1", NODE_D, [], 100, "1-abcdefghi");
        const a2 = value(WRITER_A, "2", NODE_K, [[WRITER_A, "1"]], 200, "2-abcdefghi");
        const a3 = value(WRITER_A, "3", NODE_D, [[WRITER_A, "2"]], 250, "3-abcdefghi");
        const c1 = validate(
            WRITER_C,
            "1",
            NODE_K,
            a2,
            [made(makeValidationBasisEntry(NODE_D, a3.id))],
            [[WRITER_A, "2"]],
            300
        );
        const plan = await planForeignSuffixImport({
            receiver: sourceOf([]),
            source: sourceOf([
                [WRITER_A, [a1, a2, a3]],
                [WRITER_C, [c1]],
            ]),
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            currentInputKeysOfNode,
        });
        expect("error" in plan).toBe(true);
    });

    test("the same basis value is accepted when the record's context covers it", async () => {
        const a1 = value(WRITER_A, "1", NODE_D, [], 100, "1-abcdefghi");
        const a2 = value(WRITER_A, "2", NODE_K, [[WRITER_A, "1"]], 200, "2-abcdefghi");
        const a3 = value(WRITER_A, "3", NODE_D, [[WRITER_A, "2"]], 250, "3-abcdefghi");
        const c1 = validate(
            WRITER_C,
            "1",
            NODE_K,
            a2,
            [made(makeValidationBasisEntry(NODE_D, a3.id))],
            [[WRITER_A, "3"]],
            300
        );
        const plan = await planForeignSuffixImport({
            receiver: sourceOf([]),
            source: sourceOf([
                [WRITER_A, [a1, a2, a3]],
                [WRITER_C, [c1]],
            ]),
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            currentInputKeysOfNode,
        });
        expect("error" in plan).toBe(false);
    });
});
