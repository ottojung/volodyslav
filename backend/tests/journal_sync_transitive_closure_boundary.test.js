/**
 * The documented boundary of the bounded import path's transitive-closure check.
 *
 * `incremental-graph-journal-well-formedness.md` §Transitive closure (L192-204)
 * gives this exact malformed history: a context may not include `B:1` while
 * omitting the `A:1` that `B:1` observed. The whole-history validator rejects it.
 *
 * `incremental-graph-journal-sync.md` §Final replay and validation requires
 * contexts of newly admitted records to be transitively closed against retained
 * context summaries/indexes. `incremental-graph-journal-storage.md` §Derived
 * indexes defines a context-closure summary as an optional, incrementally
 * maintained index, and §Synchronization/reset validation makes the check
 * change-bounded: the claimed prefixes are not rescanned. The receiver does not
 * maintain that optional index, so the bounded import path discharges closure
 * through the supported-source boundary instead of re-deriving it per record.
 *
 * This test pins both sides of that boundary so the reconciliation is explicit
 * rather than silent. If a context-closure summary index is added later, the
 * bounded path should reject the malformed history and this test must be updated
 * together with the boundary comment in journal_sync/admission.js.
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

/**
 * The malformed history of well-formedness.md L192-204: C:1 includes B:1 but
 * omits the A:1 that B:1 observed.
 */
function malformedHistory() {
    const a1 = value(WRITER_A, "1", NODE_K, [], 100, "1-abcdefghi");
    const b1 = value(WRITER_B, "1", NODE_X, [[WRITER_A, "1"]], 200, "2-abcdefghi");
    const c1 = value(WRITER_C, "1", NODE_Y, [[WRITER_B, "1"], [WRITER_A, "0"]], 300, "3-abcdefghi");
    return { a1, b1, c1 };
}

/**
 * The closed counterpart: C:1 also includes the A:1 that B:1 observed.
 */
function closedHistory() {
    const a1 = value(WRITER_A, "1", NODE_K, [], 100, "1-abcdefghi");
    const b1 = value(WRITER_B, "1", NODE_X, [[WRITER_A, "1"]], 200, "2-abcdefghi");
    const c1 = value(WRITER_C, "1", NODE_Y, [[WRITER_B, "1"], [WRITER_A, "1"]], 300, "3-abcdefghi");
    return { a1, b1, c1 };
}

/**
 * @param {{a1: object, b1: object, c1: object}} history
 */
function planOf(history) {
    return planForeignSuffixImport({
        receiver: makeReplicaSource(makeJournalReplica([])),
        source: makeReplicaSource(makeJournalReplica([
            [makeJournalAuthor(WRITER_A), [history.a1]],
            [makeJournalAuthor(WRITER_B), [history.b1]],
            [makeJournalAuthor(WRITER_C), [history.c1]],
        ])),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        currentInputKeysOfNode: () => [],
    });
}

describe("the bounded import path's transitive-closure boundary", () => {
    test("the whole-history validator rejects the malformed history", () => {
        const { a1, b1, c1 } = malformedHistory();
        const failure = validateJournalReplica(makeJournalReplica([
            [makeJournalAuthor(WRITER_A), [a1]],
            [makeJournalAuthor(WRITER_B), [b1]],
            [makeJournalAuthor(WRITER_C), [c1]],
        ]));
        expect(isJournalCausalClosureError(failure)).toBe(true);
    });

    test("the whole-history validator accepts the closed history", () => {
        const { a1, b1, c1 } = closedHistory();
        expect(validateJournalReplica(makeJournalReplica([
            [makeJournalAuthor(WRITER_A), [a1]],
            [makeJournalAuthor(WRITER_B), [b1]],
            [makeJournalAuthor(WRITER_C), [c1]],
        ]))).toBeUndefined();
    });

    test("the bounded import path accepts the closed history", () => {
        const plan = planOf(closedHistory());
        expect("error" in plan).toBe(false);
    });

    test("the bounded import path trusts a supported source rather than rescanning claimed prefixes", () => {
        // The reconciliation: the malformed history is a corrupt/unsupported
        // source, which the whole-history validator rejects on rebuild or
        // maintenance. The bounded path cannot re-derive closure without reading
        // the claimed prefixes, which the change-bounded read bound forbids, so it
        // accepts the source on trust. This assertion makes that boundary explicit.
        const plan = planOf(malformedHistory());
        expect("error" in plan).toBe(false);
    });
});
