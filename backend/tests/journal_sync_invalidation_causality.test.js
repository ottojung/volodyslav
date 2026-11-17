/**
 * Bounded admission checks the causality of occurrence-referencing invalidations.
 *
 * `incremental-graph-journal-sync.md` §Final replay and validation requires the
 * ValueId references a newly admitted record introduces to satisfy reference
 * causality, and `incremental-graph-journal-well-formedness.md` gives the
 * occurrence-referencing scope rule as `happenedBefore(event(V), I)`. A value
 * scope and a proof scope both name a ValueId, so both are checked; a node scope
 * names none.
 *
 * These tests pin the external behaviour of `validateImportedRecord`: a
 * barrier which names a coordinate it had not observed is refused, while a
 * barrier which names an observed coordinate is accepted.
 */

const {
    isJournalReferenceCausalityError,
    makeAuthorityTime,
    makeInvalidateEvent,
    makeJournalFrontierFromText,
    makeNodeScope,
    makeProofScope,
    makeValueScope,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const {
    validateImportedRecord,
} = require("../src/generators/incremental_graph/journal_sync/admission");

const NODE_K = { head: "event", args: [{ id: 1 }] };
const NODE_D = { head: "event", args: [{ id: 2 }] };
const KEY_K = nodeKeyToCanonicalString(NODE_K);
const KEY_D = nodeKeyToCanonicalString(NODE_D);

/**
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function schema(nodeKeyString) {
    return nodeKeyString === KEY_K ? [KEY_D] : [];
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
 * @param {object} scope
 */
function barrier(id, coordinates, physical, scope) {
    const record = makeInvalidateEvent(
        {
            id,
            context: contextOf(coordinates),
            authorityTime: makeAuthorityTime(physical, "0"),
            node: NODE_K,
        },
        scope,
        "bootstrap"
    );
    if (record instanceof Error) {
        throw new Error("the fixture built an invalid barrier: " + record.message);
    }
    return record;
}

describe("validateImportedRecord, occurrence-referencing invalidation causality", () => {
    test("a proof-scoped barrier naming a coordinate it had not observed is refused", () => {
        const record = barrier("bbbbbbbbb:1", [["aaaaaaaaa", "1"]], 2000, makeProofScope("aaaaaaaaa:2", NODE_D));
        const frontier = makeJournalFrontierFromText([["aaaaaaaaa", "2"], ["bbbbbbbbb", "1"]]);
        const failure = validateImportedRecord(record, frontier, schema);
        expect(isJournalReferenceCausalityError(failure)).toBe(true);
    });

    test("a proof-scoped barrier naming a coordinate outside the retained union is refused", () => {
        const record = barrier("bbbbbbbbb:1", [["aaaaaaaaa", "1"]], 2000, makeProofScope("aaaaaaaaa:99", NODE_D));
        const frontier = makeJournalFrontierFromText([["aaaaaaaaa", "1"], ["bbbbbbbbb", "1"]]);
        const failure = validateImportedRecord(record, frontier, schema);
        expect(isJournalReferenceCausalityError(failure)).toBe(true);
    });

    test("a value-scoped invalidation naming a coordinate it had not observed is refused", () => {
        const record = barrier("bbbbbbbbb:1", [["aaaaaaaaa", "1"]], 2000, makeValueScope("aaaaaaaaa:2"));
        const frontier = makeJournalFrontierFromText([["aaaaaaaaa", "2"], ["bbbbbbbbb", "1"]]);
        const failure = validateImportedRecord(record, frontier, schema);
        expect(isJournalReferenceCausalityError(failure)).toBe(true);
    });

    test("the acceptance is not trivial: an observed proof-scoped barrier is accepted", () => {
        const record = barrier("bbbbbbbbb:1", [["aaaaaaaaa", "1"]], 2000, makeProofScope("aaaaaaaaa:1", NODE_D));
        const frontier = makeJournalFrontierFromText([["aaaaaaaaa", "1"], ["bbbbbbbbb", "1"]]);
        expect(validateImportedRecord(record, frontier, schema)).toBeUndefined();
    });

    test("the acceptance is not trivial: an observed value-scoped invalidation is accepted", () => {
        const record = barrier("bbbbbbbbb:1", [["aaaaaaaaa", "1"]], 2000, makeValueScope("aaaaaaaaa:1"));
        const frontier = makeJournalFrontierFromText([["aaaaaaaaa", "1"], ["bbbbbbbbb", "1"]]);
        expect(validateImportedRecord(record, frontier, schema)).toBeUndefined();
    });

    test("a node-scoped invalidation names no coordinate and is accepted", () => {
        const record = makeInvalidateEvent(
            {
                id: "bbbbbbbbb:1",
                context: contextOf([]),
                authorityTime: makeAuthorityTime(2000, "0"),
                node: NODE_K,
            },
            makeNodeScope(),
            "explicit"
        );
        if (record instanceof Error) {
            throw new Error("the fixture built an invalid node-scoped invalidation: " + record.message);
        }
        const frontier = makeJournalFrontierFromText([["bbbbbbbbb", "1"]]);
        expect(validateImportedRecord(record, frontier, schema)).toBeUndefined();
    });
});
