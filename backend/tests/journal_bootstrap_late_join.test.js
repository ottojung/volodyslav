"use strict";

/**
 * `incremental-graph-journal-testing.md` §Late join versus unseen post-bootstrap
 * validation, which `incremental-graph-journal-migrations.md` §7.6 states as
 * normative behavior and `incremental-graph-journal-checklist.md` §Ordinary join
 * requires:
 *
 * > post-bootstrap validations unseen by a late join are concurrent with that
 * > join's negative proof/stale evidence and do not clear it until a causally
 * > later validation occurs.
 *
 * The scenario is the one the specification calls the intentional conservative
 * late-join trade-off. Bootstrap uses only the frozen canonical cut, so a joining
 * host's J2 proof barriers and value-scoped stale markers cannot observe cohort
 * validations which happened after that cut but before the joining host upgraded.
 * When ordinary synchronization later imports those cohort records, the
 * validation is concurrent with the joining negative evidence. Replay must not let
 * it clear that evidence merely because its `AuthorityTime` compares later
 * (`incremental-graph-journal-replay.md` §Invalidation coverage: "A concurrent
 * validation does not clear invalidation merely because total AuthorityTime
 * compares later"). Only a validation which causally observes the joining
 * evidence re-establishes the edge or clears the marker.
 *
 * Two forms of joining negative evidence are exercised, because §7.6 says the
 * joining host contributes `proof(V,D)` **and/or** `value(V)` negative evidence:
 *
 * - the proof-barrier form, where the joining legacy graph lacks the canonical
 *   `D -> V` edge, so Pass J2 authors `proof(V,D)` and the edge is retired from
 *   the selected certificate; and
 * - the value-marker form, where the joining legacy graph marks the exact-shared
 *   occurrence stale, so Pass J2 authors a value-scoped bootstrap invalidation and
 *   the occurrence is persistently stale even though its proof edge survives.
 *
 * Each form is projected three ways: the join alone, the union with a cohort
 * validation concurrent with the joining evidence, and the union with a cohort
 * validation causally after it. The first two must agree (the late import changes
 * nothing), and only the third may freshen the occurrence.
 */

const {
    isJoinedCanonicalBootstrap,
    joinCanonicalBootstrap,
    makeCanonicalBootstrapSnapshot,
    readLegacyBootstrapState,
    stageCanonicalBootstrap,
} = require("../src/generators/incremental_graph/journal/bootstrap");

const {
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeReplicaSource,
    makeValidateEvent,
    makeValidationBasisEntry,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const {
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal/oracle");

const CREATOR = "aaaaaaaaa";
const JOINER = "bbbbbbbbb";
const GRAPH_SCHEME = "incremental-graph-default";
const CREATED_AT = "2020-01-01T00:00:00.000Z";
const EARLY = "2020-01-02T00:00:00.000Z";
const LATE = "2020-03-04T00:00:00.000Z";
const TARGET_VERSION = "3";
/** A cohort validation whose clock authority is far above the joining evidence. */
const COHORT_AUTHORITY = 9999999999999;

/**
 * @param {number} id
 * @returns {object}
 */
function nodeOf(id) {
    return { head: "entry_description", args: [{ id }] };
}

/**
 * @param {number} id
 * @returns {string}
 */
function nodeKeyOf(id) {
    return nodeKeyToCanonicalString(nodeOf(id));
}

/**
 * @param {number} id
 * @returns {string}
 */
function identifierOf(id) {
    return String(id) + "-abcdefghi";
}

/**
 * @param {number} id
 * @param {string} [description]
 * @returns {object}
 */
function payloadOf(id, description) {
    return {
        type: "entry_description",
        description: description ?? "entry " + String(id),
    };
}

/**
 * @param {number} id
 * @param {object} [overrides]
 * @returns {object}
 */
function persistedNode(id, overrides) {
    return {
        nodeKeyString: nodeKeyOf(id),
        nodeIdentifier: identifierOf(id),
        payload: payloadOf(id),
        createdAt: CREATED_AT,
        modifiedAt: EARLY,
        upToDate: true,
        validInputs: [],
        ...overrides,
    };
}

/**
 * @param {ReadonlyArray<object>} nodes
 * @param {number} [lastNodeIndex]
 * @returns {object}
 */
function persistedState(nodes, lastNodeIndex) {
    return { graphSchemeString: GRAPH_SCHEME, lastNodeIndex: lastNodeIndex ?? 7, nodes };
}

/**
 * @param {object} state
 * @returns {object}
 */
function sourceOf(state) {
    const validated = readLegacyBootstrapState(state);
    if (validated instanceof Error) {
        throw validated;
    }
    return validated;
}

/**
 * @param {object} legacyState
 * @param {string} creator
 * @returns {object}
 */
function artifactFrom(legacyState, creator) {
    const candidate = stageCanonicalBootstrap({
        legacyState,
        creatorWriter: makeJournalAuthor(creator),
        targetVersion: TARGET_VERSION,
    });
    if (candidate instanceof Error) {
        throw candidate;
    }
    const artifact = makeCanonicalBootstrapSnapshot({
        records: candidate.records,
        creatorWriter: candidate.creatorWriter,
        bootstrapFrontier: candidate.bootstrapFrontier,
        databaseVersion: candidate.targetVersion,
        graphSchemeString: candidate.graphSchemeString,
    });
    if (artifact instanceof Error) {
        throw artifact;
    }
    return artifact;
}

/**
 * The current graph schema implied by a set of legacy graphs: a node's direct inputs
 * are the union of the direct legacy inputs either replica persisted for it.
 * @param {ReadonlyArray<object>} states
 * @returns {(nodeKeyString: string) => ReadonlyArray<string> | undefined}
 */
function schemaOf(states) {
    return (nodeKeyString) => {
        /** @type {Set<string>} */
        const inputs = new Set();
        let described = false;
        for (const state of states) {
            const node = state.nodeAt(nodeKeyString);
            if (node === undefined) {
                continue;
            }
            described = true;
            for (const input of node.directInputKeys) {
                inputs.add(nodeKeyToCanonicalString(input));
            }
        }
        return described ? [...inputs] : undefined;
    };
}

/**
 * @param {ReadonlyArray<object>} records
 * @returns {object}
 */
function replicaOf(records) {
    /** @type {Map<string, object[]>} */
    const byWriter = new Map();
    for (const record of records) {
        const name = journalAuthorToString(record.id.author);
        const stream = byWriter.get(name) ?? [];
        stream.push(record);
        byWriter.set(name, stream);
    }
    const replica = makeJournalReplica([...byWriter.entries()]);
    if (replica instanceof Error) {
        throw new Error("the fixture built an invalid replica: " + replica.message);
    }
    return replica;
}

/**
 * Replay a retained journal, failing the test at the fixture rather than hiding an
 * oracle rejection.
 * @param {ReadonlyArray<object>} records
 * @param {(nodeKeyString: string) => ReadonlyArray<string> | undefined} schema
 * @returns {Promise<object>}
 */
async function project(records, schema) {
    const projection = await projectRetainedJournal({
        source: makeReplicaSource(replicaOf(records)),
        localWriter: makeJournalAuthor(JOINER),
        currentInputKeysOfNode: schema,
    });
    if (projection instanceof Error) {
        throw new Error("the oracle rejected the union: " + projection.message);
    }
    return projection;
}

/**
 * The current occurrence of one node, which the assertions read.
 * @param {object} projection
 * @param {number} id
 * @returns {object}
 */
function occurrenceOf(projection, id) {
    const occurrence = projection.occurrences.find(
        (candidate) => candidate.nodeKeyString === nodeKeyOf(id)
    );
    if (occurrence === undefined) {
        throw new Error("the projection lost the occurrence of node " + String(id));
    }
    return occurrence;
}

/**
 * The canonical cut's `D -> V` edge, as the basis a cohort validation re-proves.
 * @returns {{artifact: object, canonicalD: object, canonicalK: object, state: object}}
 */
function canonicalCut() {
    const state = sourceOf(
        persistedState([
            persistedNode(1, { modifiedAt: EARLY }),
            persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
        ])
    );
    const artifact = artifactFrom(state, CREATOR);
    const canonicalD = artifact.records.find(
        (record) => record.kind === "value" && nodeKeyToCanonicalString(record.node) === nodeKeyOf(1)
    );
    const canonicalK = artifact.records.find(
        (record) => record.kind === "value" && nodeKeyToCanonicalString(record.node) === nodeKeyOf(2)
    );
    return { artifact, canonicalD, canonicalK, state };
}

/**
 * A cohort validation of V authored after the cut. Its basis names the canonical
 * D occurrence, so it re-proves exactly the edge the joining barrier retires and
 * covers exactly the value marker the joining host authors.
 * @param {object} cut
 * @param {ReadonlyArray<ReadonlyArray<string>>} observed - Extra cross-writer
 *   coordinates the validation observed, beyond its own CREATOR prefix.
 * @returns {object}
 */
function cohortValidation(cut, observed) {
    const record = makeValidateEvent(
        {
            id: CREATOR + ":6",
            context: makeJournalFrontierFromText([[CREATOR, "5"], ...observed]),
            authorityTime: makeAuthorityTime(COHORT_AUTHORITY, "0"),
            node: nodeOf(2),
        },
        journalRecordIdToString(cut.canonicalK.id),
        [makeValidationBasisEntry(nodeOf(1), journalRecordIdToString(cut.canonicalD.id))],
        "compute"
    );
    if (record instanceof Error) {
        throw record;
    }
    return record;
}

/**
 * Assert the two facts the late-join trade-off guarantees about the negative
 * evidence: it is authored by the joining writer for the bootstrap reason, and the
 * concurrent cohort validation has greater clock authority than it.
 * @param {object} negative
 * @param {object} concurrent
 */
function expectConservativeNegativeEvidence(negative, concurrent) {
    expect(journalAuthorToString(negative.id.author)).toBe(JOINER);
    expect(negative.reason).toBe("bootstrap");
    // The cohort validation's authority is strictly greater, so a replay which let
    // clock authority decide would wrongly clear the joining evidence.
    expect(concurrent.authorityTime.physical).toBeGreaterThan(negative.authorityTime.physical);
}

describe("late join versus unseen post-bootstrap validation, proof-barrier evidence", () => {
    /**
     * The joining legacy graph holds the exact-shared occurrence but lacks the
     * canonical `D -> K` edge, so Pass J2 authors a `proof(V,D)` barrier and no
     * value marker.
     * @returns {Promise<{cut: object, joined: object, barrier: object, schema: object}>}
     */
    async function fixture() {
        const cut = canonicalCut();
        const joining = sourceOf(
            persistedState(
                [
                    persistedNode(1, { modifiedAt: EARLY }),
                    persistedNode(2, { modifiedAt: LATE, validInputs: [] }),
                ],
                9
            )
        );
        const schema = schemaOf([joining, cut.state]);
        const joined = await joinCanonicalBootstrap({
            legacyState: joining,
            artifact: cut.artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schema,
        });
        expect(isJoinedCanonicalBootstrap(joined)).toBe(true);
        if (joined instanceof Error) {
            throw joined;
        }
        const barrier = joined.records.find(
            (record) => record.kind === "invalidate" && record.scope.kind === "proof"
        );
        expect(barrier).toBeDefined();
        if (barrier === undefined || barrier.scope.kind !== "proof") {
            throw new Error("the join authored no proof barrier");
        }
        return { cut, joined, barrier, schema };
    }

    test("the join retires the edge and authors a proof(V,D) barrier", async () => {
        const { joined, barrier, cut } = await fixture();
        expect(nodeKeyToCanonicalString(barrier.scope.input)).toBe(nodeKeyOf(1));
        expect(journalRecordIdToString(barrier.scope.value)).toBe(
            journalRecordIdToString(cut.canonicalK.id)
        );
        const selected = occurrenceOf(joined.projection, 2);
        // The barrier is uncovered for the retained canonical certificate, so the
        // edge is absent and the occurrence is hard stale before any cohort record.
        expect(selected.fresh).toBe(false);
        expect([...selected.validInputs]).toEqual([]);
    });

    test("a concurrent cohort validation does not clear the barrier", async () => {
        const { joined, barrier, cut, schema } = await fixture();
        const concurrent = cohortValidation(cut, []);
        expectConservativeNegativeEvidence(barrier, concurrent);
        // The validation does not observe the joining barrier.
        expect([...concurrent.context].map((entry) => journalAuthorToString(entry[0]))).not.toContain(
            JOINER
        );

        const projection = await project([...joined.records, concurrent], schema);
        const selected = occurrenceOf(projection, 2);
        // The imported validation is present and would prove the edge, but it is
        // concurrent with the barrier, so it cannot re-establish D.
        expect(projection.occurrences.some((o) => o.nodeKeyString === nodeKeyOf(2))).toBe(true);
        expect(selected.fresh).toBe(false);
        expect([...selected.validInputs]).toEqual([]);
    });

    test("a validation causally after the barrier re-proves the edge", async () => {
        const { joined, barrier, cut, schema } = await fixture();
        const causallyAfter = cohortValidation(cut, [
            [JOINER, journalSequenceToString(barrier.id.sequence)],
        ]);

        const projection = await project([...joined.records, causallyAfter], schema);
        const selected = occurrenceOf(projection, 2);
        expect(selected.fresh).toBe(true);
        expect([...selected.validInputs]).toEqual([nodeKeyOf(1)]);
    });
});

describe("late join versus unseen post-bootstrap validation, value-marker evidence", () => {
    /**
     * The joining legacy graph holds the exact-shared occurrence, keeps the
     * `D -> K` edge, but marks the occurrence stale, so Pass J2 authors a
     * value-scoped bootstrap invalidation and no proof barrier.
     * @returns {Promise<{cut: object, joined: object, marker: object, schema: object}>}
     */
    async function fixture() {
        const cut = canonicalCut();
        const joining = sourceOf(
            persistedState(
                [
                    persistedNode(1, { modifiedAt: EARLY }),
                    persistedNode(2, {
                        modifiedAt: LATE,
                        upToDate: false,
                        validInputs: [nodeKeyOf(1)],
                    }),
                ],
                9
            )
        );
        const schema = schemaOf([joining, cut.state]);
        const joined = await joinCanonicalBootstrap({
            legacyState: joining,
            artifact: cut.artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schema,
        });
        expect(isJoinedCanonicalBootstrap(joined)).toBe(true);
        if (joined instanceof Error) {
            throw joined;
        }
        // The joining edge is present, so no proof barrier is authored.
        expect(
            joined.records.some(
                (record) => record.kind === "invalidate" && record.scope.kind === "proof"
            )
        ).toBe(false);
        const marker = joined.records.find(
            (record) => record.kind === "invalidate" && record.scope.kind === "value"
        );
        expect(marker).toBeDefined();
        if (marker === undefined || marker.scope.kind !== "value") {
            throw new Error("the join authored no value marker");
        }
        return { cut, joined, marker, schema };
    }

    test("the join keeps the edge but authors a value(V) bootstrap marker", async () => {
        const { joined, marker, cut } = await fixture();
        expect(journalRecordIdToString(marker.scope.value)).toBe(
            journalRecordIdToString(cut.canonicalK.id)
        );
        const selected = occurrenceOf(joined.projection, 2);
        // The proof edge survives, but the uncovered value marker makes the
        // occurrence persistently stale.
        expect([...selected.validInputs]).toEqual([nodeKeyOf(1)]);
        expect(selected.fresh).toBe(false);
    });

    test("a concurrent cohort validation does not clear the marker", async () => {
        const { joined, marker, cut, schema } = await fixture();
        const concurrent = cohortValidation(cut, []);
        expectConservativeNegativeEvidence(marker, concurrent);

        const projection = await project([...joined.records, concurrent], schema);
        const selected = occurrenceOf(projection, 2);
        // The edge is proven, yet the concurrent validation does not cover the
        // value marker, so the occurrence stays persistently stale.
        expect([...selected.validInputs]).toEqual([nodeKeyOf(1)]);
        expect(selected.fresh).toBe(false);
    });

    test("a validation causally after the marker clears it", async () => {
        const { joined, marker, cut, schema } = await fixture();
        const causallyAfter = cohortValidation(cut, [
            [JOINER, journalSequenceToString(marker.id.sequence)],
        ]);

        const projection = await project([...joined.records, causallyAfter], schema);
        const selected = occurrenceOf(projection, 2);
        expect([...selected.validInputs]).toEqual([nodeKeyOf(1)]);
        expect(selected.fresh).toBe(true);
    });
});
