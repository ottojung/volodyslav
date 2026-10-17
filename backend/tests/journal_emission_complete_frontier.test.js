/**
 * Ordinary emission builds every context from the complete committed retained
 * frontier.
 *
 * `incremental-graph-journal-emission.md` §Contexts are complete semantic
 * observation owns the rule: an ordinary publication's context is finalized from
 * the complete committed retained frontier, not from the subset of history the
 * computation touched, its validation basis named, or its references reached.
 * `incremental-graph-journal-testing.md` §Ordinary publication uses the complete
 * committed frontier pins the consequence: after a foreign writer imports a
 * node-scoped invalidation of `K` plus an unrelated foreign record, an ordinary
 * local revalidation of `K` must observe the whole frontier, so its certificate
 * causally covers the invalidation and `K` becomes fresh again even though the
 * computation never referenced the foreign history.
 *
 * The fixture builds the complete frontier a foreign import leaves behind, hands
 * it to the same `finalizeEmission` the production commit seam calls
 * (`graph_state.js`), and then replays the union of the foreign history and the
 * emitted record. A context built from touched inputs, ValueIds, or referenced
 * records would omit the foreign coordinates and leave `K` stale.
 */

const {
    finalizeEmission,
    isValidateEvent,
    journalAuthorToString,
    journalSequenceToString,
    makeAuthorityTime,
    makeInvalidateEvent,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeJournalSequence,
    makeNodeScope,
    makeValidateEvent,
    makeValueEvent,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");
const {
    makeReplicaSource,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal/oracle");

const LOCAL = "aaaaaaaaa";
const PEER = "bbbbbbbbb";
const NODE_K = { head: "event", args: [{ id: 1 }] };
const NODE_D = { head: "event", args: [{ id: 2 }] };
const KEY_K = nodeKeyToCanonicalString(NODE_K);
const KEY_D = nodeKeyToCanonicalString(NODE_D);
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const PAYLOAD = { type: "entry_description", description: "x" };

/**
 * The chain schema has no edges: both fixture nodes are leaves, so a leaf's
 * certificate proves the complete current input set with an empty basis.
 * @param {string} _nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function leafSchema(_nodeKeyString) {
    return [];
}

/**
 * @param {ReadonlyArray<[string, string]>} coordinates
 * @returns {import("../src/generators/incremental_graph/journal").JournalFrontier}
 */
function contextOf(coordinates) {
    const frontier = makeJournalFrontierFromText(coordinates);
    if (frontier instanceof Error) {
        throw new Error("the fixture built a malformed context: " + frontier.message);
    }
    return frontier;
}

/**
 * @param {number} physical
 * @param {string} [logical]
 * @returns {import("../src/generators/incremental_graph/journal").AuthorityTime}
 */
function authorityOf(physical, logical) {
    const time = makeAuthorityTime(physical, logical === undefined ? "0" : logical);
    if (time instanceof Error) {
        throw new Error("the fixture built a malformed authority time: " + time.message);
    }
    return time;
}

/**
 * @template T
 * @param {T | import("../src/generators/incremental_graph/journal").JournalError} value
 * @returns {T}
 */
function made(value) {
    if (value instanceof Error) {
        throw new Error("the fixture built an invalid record: " + value.message);
    }
    return value;
}

/**
 * The local writer's first materialization of `K`. It observes nothing, so it is
 * concurrent with the foreign node-scoped invalidation below.
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
 */
function localMaterializationOfK() {
    return made(makeValueEvent(
        { id: LOCAL + ":1", context: contextOf([]), authorityTime: authorityOf(1), node: NODE_K },
        "1-abcdefghi",
        PAYLOAD,
        NOW,
        LATER,
        "compute"
    ));
}

/**
 * The foreign writer's node-scoped invalidation of `K`, concurrent with the
 * local materialization.
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
 */
function foreignInvalidationOfK() {
    return made(makeInvalidateEvent(
        { id: PEER + ":1", context: contextOf([]), authorityTime: authorityOf(2), node: NODE_K },
        makeNodeScope(),
        "explicit"
    ));
}

/**
 * The unrelated foreign record the next computation does not reference. It is a
 * materialization of a different node, so it is neither an input nor a ValueId
 * of `K`.
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
 */
function unrelatedForeignRecord() {
    return made(makeValueEvent(
        { id: PEER + ":2", context: contextOf([[PEER, "1"]]), authorityTime: authorityOf(3), node: NODE_D },
        "2-abcdefghi",
        PAYLOAD,
        NOW,
        LATER,
        "compute"
    ));
}

/**
 * The committed frontier a foreign import of the two records above leaves behind
 * for the local writer, whose own head is its first materialization.
 * @returns {import("../src/generators/incremental_graph/journal").JournalFrontier}
 */
function importedFrontier() {
    return contextOf([[LOCAL, "1"], [PEER, "2"]]);
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {import("../src/generators/incremental_graph/journal/oracle").Projection | Error}
 */
function projectUnion(records) {
    const streams = [
        [made(makeJournalAuthor(LOCAL)), records.filter((record) => journalAuthorToString(record.id.author) === LOCAL)],
        [made(makeJournalAuthor(PEER)), records.filter((record) => journalAuthorToString(record.id.author) === PEER)],
    ];
    const replica = makeJournalReplica(streams);
    if (replica instanceof Error) {
        throw new Error("the fixture union is not a well-formed replica: " + replica.message);
    }
    return projectRetainedJournal({
        source: makeReplicaSource(replica),
        localWriter: made(makeJournalAuthor(LOCAL)),
        currentInputKeysOfNode: leafSchema,
    });
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @param {string} nodeKeyString
 * @returns {boolean | undefined}
 */
function freshnessOf(records, nodeKeyString) {
    const projection = projectUnion(records);
    if (projection instanceof Error) {
        throw new Error("replay rejected the fixture union: " + projection.message);
    }
    const occurrence = projection.occurrences.find((candidate) => candidate.nodeKeyString === nodeKeyString);
    return occurrence === undefined ? undefined : occurrence.fresh;
}

describe("ordinary emission observes the complete committed retained frontier", () => {
    test("the foreign node invalidation is effective before the local revalidation", () => {
        // The local certificate does not causally observe the concurrent foreign
        // node invalidation, so it is ineligible and `K` is not fresh.
        expect(freshnessOf([localMaterializationOfK(), foreignInvalidationOfK(), unrelatedForeignRecord()], KEY_K))
            .toBe(false);
    });

    test("a revalidation from the complete frontier covers the invalidation and freshens K", () => {
        const state = {
            localWriter: made(makeJournalAuthor(LOCAL)),
            writerHead: made(makeJournalSequence("1")),
            committedFrontier: importedFrontier(),
            authorityHighWater: authorityOf(1),
            allocatorWatermark: 0,
        };
        const publication = finalizeEmission({
            state,
            intents: [{ kind: "revalidate", node: NODE_K, value: LOCAL + ":1", inputs: [] }],
            publicationInstant: 4,
            allocatorWatermark: 0,
        });
        if (publication instanceof Error) {
            throw new Error("emission rejected the revalidation: " + publication.message);
        }

        // The allocator watermark did not advance, so the publication authors no
        // writer-state record and exactly the one revalidation.
        expect(publication.records).toHaveLength(1);
        const revalidation = publication.records[0];
        expect(isValidateEvent(revalidation)).toBe(true);
        if (!isValidateEvent(revalidation)) {
            throw new Error("the revalidation was not a validation");
        }
        expect(journalAuthorToString(revalidation.id.author)).toBe(LOCAL);
        expect(journalSequenceToString(revalidation.id.sequence)).toBe("2");
        // The context is the complete committed frontier with the exact own
        // prefix: the unrelated foreign coordinate `PEER:2` is present even
        // though no input, ValueId, or reference of this computation names it.
        expect([...revalidation.context].map((coordinate) => [
            journalAuthorToString(coordinate[0]),
            journalSequenceToString(coordinate[1]),
        ])).toEqual([[LOCAL, "1"], [PEER, "2"]]);

        // Replaying the union makes the semantic consequence observable: the
        // complete context causally covers `PEER:1`, so `K` is fresh again.
        expect(freshnessOf(
            [localMaterializationOfK(), foreignInvalidationOfK(), unrelatedForeignRecord(), revalidation],
            KEY_K
        )).toBe(true);
        // The unrelated foreign node stays untouched by the revalidation.
        expect(freshnessOf(
            [localMaterializationOfK(), foreignInvalidationOfK(), unrelatedForeignRecord(), revalidation],
            KEY_D
        )).toBe(false);
    });

    test("a context built only from the referenced records leaves K stale", () => {
        // The counterfactual the specification forbids: the revalidation's
        // context names only the ValueId it references, so it does not observe
        // the foreign node invalidation and cannot freshen `K`.
        const narrow = made(makeValidateEvent(
            {
                id: LOCAL + ":2",
                context: contextOf([[LOCAL, "1"]]),
                authorityTime: authorityOf(4),
                node: NODE_K,
            },
            LOCAL + ":1",
            [],
            "compute"
        ));
        expect(freshnessOf(
            [localMaterializationOfK(), foreignInvalidationOfK(), unrelatedForeignRecord(), narrow],
            KEY_K
        )).toBe(false);
    });
});
