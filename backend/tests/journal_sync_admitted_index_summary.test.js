/**
 * The admitted-relations index retains a compact summary of each admitted
 * record, never the record itself.
 *
 * `incremental-graph-journal-sync.md` section Streamability requires the bounded
 * import path to keep missing suffixes incrementally iterable and to never hold
 * the complete suffix in RAM. `journal_sync/admission.js` documents that the
 * index "is the only derived state that needs to span the change set; the records
 * themselves are not retained". A prior implementation stored the whole
 * `JournalRecord` per admitted coordinate, retaining every payload; this suite
 * pins the summary the reference resolver actually needs (`isValue` and the
 * node, for a `ValueEvent`).
 */

const {
    makeAuthorityTime,
    makeJournalFrontierFromText,
    makeValidateEvent,
    makeValueEvent,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const {
    makeAdmittedIndex,
} = require("../src/generators/incremental_graph/journal_sync/admission");

const WRITER_A = "aaaaaaaaa";
const NODE_K = { head: "event", args: [{ id: 1 }] };
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";

describe("the admitted-relations index retains only a summary of each record", () => {
    test("a ValueEvent is summarised as { isValue: true, node } without its payload", () => {
        const record = makeValueEvent(
            {
                id: WRITER_A + ":1",
                context: makeJournalFrontierFromText([]),
                authorityTime: makeAuthorityTime(100, "0"),
                node: NODE_K,
            },
            "1-abcdefghi",
            { type: "entry_description", description: "payload-that-must-not-be-retained" },
            NOW,
            LATER,
            "compute"
        );
        const index = makeAdmittedIndex();
        index.add(record);
        const summary = index.recordOf(record.id);
        expect(summary).toBeDefined();
        expect(summary.isValue).toBe(true);
        expect(summary.node).toEqual(NODE_K);
        expect("value" in summary).toBe(false);
        expect(summary).not.toBe(record);
    });

    test("a ValidateEvent is summarised as { isValue: false } with no node", () => {
        const record = makeValidateEvent(
            {
                id: WRITER_A + ":1",
                context: makeJournalFrontierFromText([]),
                authorityTime: makeAuthorityTime(100, "0"),
                node: NODE_K,
            },
            "bbbbbbbbb:1",
            [],
            "compute"
        );
        const index = makeAdmittedIndex();
        index.add(record);
        const summary = index.recordOf(record.id);
        expect(summary).toBeDefined();
        expect(summary.isValue).toBe(false);
        expect(summary.node).toBeUndefined();
        expect("basis" in summary).toBe(false);
    });

    test("the summary node is the canonical NodeKeyString the resolver compares", () => {
        const record = makeValueEvent(
            {
                id: WRITER_A + ":1",
                context: makeJournalFrontierFromText([]),
                authorityTime: makeAuthorityTime(100, "0"),
                node: NODE_K,
            },
            "1-abcdefghi",
            { type: "entry_description", description: "v1" },
            NOW,
            LATER,
            "compute"
        );
        const index = makeAdmittedIndex();
        index.add(record);
        expect(nodeKeyToCanonicalString(index.recordOf(record.id).node))
            .toBe(nodeKeyToCanonicalString(NODE_K));
    });
});
