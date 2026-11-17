"use strict";

/**
 * `incremental-graph-journal-testing.md` §Bootstrap recursive-only stale
 * propagation (testing.md:656-674) over the longer chains and branching DAGs
 * the section's closing line requires:
 *
 * > Run this over longer chains/branching DAGs and require one deterministic
 * > topological propagation pass to persist every recursive stale transition.
 *
 * The two-node fixture (D -> K) is already covered by
 * journal_canonical_bootstrap_consumer.test.js ("recursive-only staleness is
 * persisted for a dependent of a stale occurrence"). This suite extends the
 * section's own fixture to a three-node chain (D -> K -> L), a fan-out
 * (D -> K1, D -> K2) and a fan-in (D1 -> K, D2 -> K), and drives the
 * post-join sequence the section fixes as expectations 4 and 5: a later
 * `pull(D) -> Unchanged` may freshen D but MUST NOT freshen K, and K becomes
 * fresh only when K validates/recomputes.
 *
 * The fixture is the section's:
 *
 * ```text
 * D -> K
 * canonical: D exact occurrence fresh; K fresh with full {D:Dc}
 * joining: same D occurrence stale; K absent or a losing different occurrence
 * ```
 *
 * extended with L fresh with full {K:Kc} on the canonical side. Because the
 * canonical cut holds D, K and L all fresh, any staleness the join persists
 * for K and L is recursive-only: neither side holds direct stale evidence for
 * them, so the J2b markers exist only because the single input-to-dependent
 * topological pass reached them through their stale inputs.
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
    journalSequenceAtFrontier,
    journalSequenceToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontier,
    makeJournalReplica,
    makeReplicaSource,
    makeValidateEvent,
    makeValidationBasisEntry,
    nodeKeyToCanonicalString,
    successorJournalSequence,
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
 * The current graph schema implied by a set of legacy graphs: a node's direct
 * inputs are the union of the direct legacy inputs either replica persisted.
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
 * The canonical ValueId the cut authored for one node.
 * @param {object} artifact
 * @param {number} id
 * @returns {string}
 */
function canonicalValueIdOf(artifact, id) {
    const record = artifact.records.find(
        (candidate) =>
            candidate.kind === "value" && nodeKeyToCanonicalString(candidate.node) === nodeKeyOf(id)
    );
    if (record === undefined) {
        throw new Error("the canonical cut authored no value for node " + String(id));
    }
    return journalRecordIdToString(record.id);
}

/**
 * The value-scoped bootstrap invalidation the join persisted for one node.
 * @param {ReadonlyArray<object>} records
 * @param {number} id
 * @returns {object | undefined}
 */
function valueMarkerOf(records, id) {
    return records.find(
        (record) =>
            record.kind === "invalidate" &&
            record.scope.kind === "value" &&
            nodeKeyToCanonicalString(record.node) === nodeKeyOf(id)
    );
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
 * Replay a retained journal, failing the test at the fixture rather than hiding
 * an oracle rejection.
 * @param {ReadonlyArray<object>} records
 * @param {(nodeKeyString: string) => ReadonlyArray<string> | undefined} schema
 * @returns {Promise<object>}
 */
async function project(records, schema) {
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
    const projection = await projectRetainedJournal({
        source: makeReplicaSource(replica),
        localWriter: makeJournalAuthor(JOINER),
        currentInputKeysOfNode: schema,
    });
    if (projection instanceof Error) {
        throw new Error("the oracle rejected the union: " + projection.message);
    }
    return projection;
}

/**
 * A cohort validation causally after every record of the joined journal: its
 * context is the joined frontier, so it observes each joining marker it is
 * meant to cover, and its identifier is the creator's next sequence.
 * @param {object} joined
 * @param {number} node
 * @param {string} value
 * @param {ReadonlyArray<object>} basis
 * @param {string} reason
 * @returns {object}
 */
function cohortValidationAfter(joined, node, value, basis, reason) {
    const creator = makeJournalAuthor(CREATOR);
    const base = journalSequenceAtFrontier(joined.frontier, creator);
    const next = successorJournalSequence(base);
    if (next instanceof Error) {
        throw next;
    }
    // Own-writer context exactness: context[CREATOR] must be exactly one below
    // the identifier's sequence, which is the frontier coordinate being
    // extended.
    const context = makeJournalFrontier([
        ...[...joined.frontier].filter(
            (entry) => journalAuthorToString(entry[0]) !== CREATOR
        ),
        [creator, base],
    ]);
    if (context instanceof Error) {
        throw context;
    }
    const record = makeValidateEvent(
        {
            id: CREATOR + ":" + journalSequenceToString(next),
            context,
            authorityTime: makeAuthorityTime(COHORT_AUTHORITY, "0"),
            node: nodeOf(node),
        },
        value,
        basis,
        reason
    );
    if (record instanceof Error) {
        throw record;
    }
    return record;
}

/**
 * The frontier a later cohort validation observes: the joined frontier plus
 * the creator records authored after the join.
 * @param {object} joined
 * @param {number} extraCreatorRecords
 * @returns {object}
 */
function frontierAfter(joined, extraCreatorRecords) {
    const creator = makeJournalAuthor(CREATOR);
    const base = journalSequenceAtFrontier(joined.frontier, creator);
    let sequence = base;
    for (let index = 0; index < extraCreatorRecords; index += 1) {
        const next = successorJournalSequence(sequence);
        if (next instanceof Error) {
            throw next;
        }
        sequence = next;
    }
    const frontier = makeJournalFrontier([
        ...[...joined.frontier].filter(
            (entry) => journalAuthorToString(entry[0]) !== CREATOR
        ),
        [creator, sequence],
    ]);
    if (frontier instanceof Error) {
        throw frontier;
    }
    return frontier;
}

describe("recursive-only stale propagation over a longer chain", () => {
    /**
     * The section's fixture extended to a three-node chain: the canonical cut
     * holds D, K and L all fresh with full proof, and the joining legacy graph
     * materializes only the same D occurrence, stale.
     * @returns {Promise<{joined: object, artifact: object, schema: object}>}
     */
    async function fixture() {
        const canonicalState = sourceOf(
            persistedState([
                persistedNode(1, { modifiedAt: EARLY }),
                persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
                persistedNode(3, { modifiedAt: LATE, validInputs: [nodeKeyOf(2)] }),
            ])
        );
        const artifact = artifactFrom(canonicalState, CREATOR);
        const joining = sourceOf(
            persistedState([persistedNode(1, { upToDate: false })], 9)
        );
        const schema = schemaOf([joining, canonicalState]);
        const joined = await joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schema,
        });
        expect(isJoinedCanonicalBootstrap(joined)).toBe(true);
        if (joined instanceof Error) {
            throw joined;
        }
        return { joined, artifact, schema };
    }

    test("one topological pass persists every recursive stale transition of the D -> K -> L chain", async () => {
        const { joined, artifact } = await fixture();
        // Expectation 1: J2 makes the shared Dc persistently stale.
        const markerD = valueMarkerOf(joined.records, 1);
        expect(markerD).toBeDefined();
        if (markerD === undefined || markerD.scope.kind !== "value") {
            throw new Error("the join authored no value marker for D");
        }
        expect(journalRecordIdToString(markerD.scope.value)).toBe(canonicalValueIdOf(artifact, 1));
        expect(journalAuthorToString(markerD.id.author)).toBe(JOINER);
        expect(markerD.reason).toBe("bootstrap");
        // Expectations 2 and 3: K stays canonical and self-proof-ready at the
        // J2b pre-marker cut, so J2b detects K stale solely through D and
        // authors the value(Kc) bootstrap marker. The marker's existence is the
        // observable proof of the pre-marker cut: J2b authors it only for a
        // node whose own proof was ready at that cut.
        const markerK = valueMarkerOf(joined.records, 2);
        expect(markerK).toBeDefined();
        if (markerK === undefined || markerK.scope.kind !== "value") {
            throw new Error("the join authored no value marker for K");
        }
        expect(journalRecordIdToString(markerK.scope.value)).toBe(canonicalValueIdOf(artifact, 2));
        expect(journalAuthorToString(markerK.id.author)).toBe(JOINER);
        expect(markerK.reason).toBe("bootstrap");
        // The same pass reaches L recursively through K: L is fresh in the
        // canonical cut and absent on the joining side, so its marker is
        // recursive-only evidence persisted in this single join.
        const markerL = valueMarkerOf(joined.records, 3);
        expect(markerL).toBeDefined();
        if (markerL === undefined || markerL.scope.kind !== "value") {
            throw new Error("the join authored no value marker for L");
        }
        expect(journalRecordIdToString(markerL.scope.value)).toBe(canonicalValueIdOf(artifact, 3));
        expect(journalAuthorToString(markerL.id.author)).toBe(JOINER);
        expect(markerL.reason).toBe("bootstrap");
        // Exactly one marker per node: the pass persisted each recursive
        // transition once, with no duplicate or missing marker.
        for (const id of [1, 2, 3]) {
            const markers = joined.records.filter(
                (record) =>
                    record.kind === "invalidate" &&
                    record.scope.kind === "value" &&
                    nodeKeyToCanonicalString(record.node) === nodeKeyOf(id)
            );
            expect(markers).toHaveLength(1);
        }
        // The canonical occurrences survive with their canonical ValueIds, and
        // proof validity stays separate from persistent freshness: K and L keep
        // their canonical validity edges while all three occurrences are stale.
        const selectedD = occurrenceOf(joined.projection, 1);
        const selectedK = occurrenceOf(joined.projection, 2);
        const selectedL = occurrenceOf(joined.projection, 3);
        expect(journalRecordIdToString(selectedD.valueId)).toBe(canonicalValueIdOf(artifact, 1));
        expect(journalRecordIdToString(selectedK.valueId)).toBe(canonicalValueIdOf(artifact, 2));
        expect(journalRecordIdToString(selectedL.valueId)).toBe(canonicalValueIdOf(artifact, 3));
        expect(selectedD.fresh).toBe(false);
        expect(selectedK.fresh).toBe(false);
        expect(selectedL.fresh).toBe(false);
        expect([...selectedK.validInputs]).toEqual([nodeKeyOf(1)]);
        expect([...selectedL.validInputs]).toEqual([nodeKeyOf(2)]);
    });

    test("a later pull(D) -> Unchanged freshens D but neither K nor L", async () => {
        const { joined, artifact, schema } = await fixture();
        // Expectation 4: the cohort later pulls D as Unchanged. The validation
        // causally observes the joining marker on D, so it covers it and D
        // freshens; K and L hold their own uncovered bootstrap markers and
        // MUST NOT freshen.
        const pullD = cohortValidationAfter(
            joined,
            1,
            canonicalValueIdOf(artifact, 1),
            [],
            "unchanged"
        );
        const projection = await project([...joined.records, pullD], schema);
        expect(occurrenceOf(projection, 1).fresh).toBe(true);
        expect(occurrenceOf(projection, 2).fresh).toBe(false);
        expect(occurrenceOf(projection, 3).fresh).toBe(false);
        // The markers are retained history: the later validation covers them for
        // replay but does not remove the records.
        expect(valueMarkerOf([...joined.records, pullD], 2)).toBeDefined();
        expect(valueMarkerOf([...joined.records, pullD], 3)).toBeDefined();
    });

    test("K freshens only when K validates; L stays stale until L validates", async () => {
        const { joined, artifact, schema } = await fixture();
        const pullD = cohortValidationAfter(
            joined,
            1,
            canonicalValueIdOf(artifact, 1),
            [],
            "unchanged"
        );
        // Expectation 5: K becomes fresh only when K validates/recomputes. The
        // validation observes the joining marker on K and re-proves the D -> K
        // edge against the now-fresh D.
        const validateK = cohortValidationAfter(
            { ...joined, frontier: frontierAfter(joined, 1) },
            2,
            canonicalValueIdOf(artifact, 2),
            [makeValidationBasisEntry(nodeOf(1), canonicalValueIdOf(artifact, 1))],
            "compute"
        );
        const afterK = await project([...joined.records, pullD, validateK], schema);
        expect(occurrenceOf(afterK, 1).fresh).toBe(true);
        expect(occurrenceOf(afterK, 2).fresh).toBe(true);
        // L's input K is fresh, yet L's own bootstrap marker is still
        // uncovered: recursive-only staleness persists independently of the
        // input freshening, so L stays stale until L itself validates.
        expect(occurrenceOf(afterK, 3).fresh).toBe(false);
        const validateL = cohortValidationAfter(
            { ...joined, frontier: frontierAfter(joined, 2) },
            3,
            canonicalValueIdOf(artifact, 3),
            [makeValidationBasisEntry(nodeOf(2), canonicalValueIdOf(artifact, 2))],
            "compute"
        );
        const afterL = await project([...joined.records, pullD, validateK, validateL], schema);
        expect(occurrenceOf(afterL, 1).fresh).toBe(true);
        expect(occurrenceOf(afterL, 2).fresh).toBe(true);
        expect(occurrenceOf(afterL, 3).fresh).toBe(true);
    });
});

describe("recursive-only stale propagation over branching DAGs", () => {
    /**
     * A fan-out canonical cut: D fresh, K1 and K2 both fresh with full {D:Dc}.
     * @returns {object}
     */
    function fanOutCut() {
        const canonicalState = sourceOf(
            persistedState([
                persistedNode(1, { modifiedAt: EARLY }),
                persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
                persistedNode(3, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
            ])
        );
        return { canonicalState, artifact: artifactFrom(canonicalState, CREATOR) };
    }

    test("fan-out: one stale D stales K1 and K2 in the same single pass", async () => {
        const { canonicalState, artifact } = fanOutCut();
        const joining = sourceOf(
            persistedState([persistedNode(1, { upToDate: false })], 9)
        );
        const schema = schemaOf([joining, canonicalState]);
        const joined = await joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schema,
        });
        expect(isJoinedCanonicalBootstrap(joined)).toBe(true);
        if (joined instanceof Error) {
            throw joined;
        }
        // J2 persists the direct evidence on D; J2b reaches both dependents
        // solely through D in the same input-to-dependent pass.
        for (const id of [1, 2, 3]) {
            const marker = valueMarkerOf(joined.records, id);
            expect(marker).toBeDefined();
            if (marker === undefined || marker.scope.kind !== "value") {
                throw new Error("the join authored no value marker for node " + String(id));
            }
            expect(journalRecordIdToString(marker.scope.value)).toBe(
                canonicalValueIdOf(artifact, id)
            );
            expect(journalAuthorToString(marker.id.author)).toBe(JOINER);
            expect(marker.reason).toBe("bootstrap");
        }
        const selectedK1 = occurrenceOf(joined.projection, 2);
        const selectedK2 = occurrenceOf(joined.projection, 3);
        expect(selectedK1.fresh).toBe(false);
        expect(selectedK2.fresh).toBe(false);
        expect([...selectedK1.validInputs]).toEqual([nodeKeyOf(1)]);
        expect([...selectedK2.validInputs]).toEqual([nodeKeyOf(1)]);
    });

    test("fan-in: a stale D1 stales K while the fresh D2 stays fresh", async () => {
        const canonicalState = sourceOf(
            persistedState([
                persistedNode(1, { modifiedAt: EARLY }),
                persistedNode(2, { modifiedAt: EARLY }),
                persistedNode(3, {
                    modifiedAt: LATE,
                    validInputs: [nodeKeyOf(1), nodeKeyOf(2)],
                }),
            ])
        );
        const artifact = artifactFrom(canonicalState, CREATOR);
        // Only D1 is stale on the joining side; D2 stays fresh and K is absent.
        const joining = sourceOf(
            persistedState(
                [persistedNode(1, { upToDate: false }), persistedNode(2)],
                9
            )
        );
        const schema = schemaOf([joining, canonicalState]);
        const joined = await joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schema,
        });
        expect(isJoinedCanonicalBootstrap(joined)).toBe(true);
        if (joined instanceof Error) {
            throw joined;
        }
        // D1 carries the direct evidence; K is detected stale solely through
        // D1. D2 holds no stale evidence of its own and stays fresh.
        const markerD1 = valueMarkerOf(joined.records, 1);
        expect(markerD1).toBeDefined();
        if (markerD1 === undefined || markerD1.scope.kind !== "value") {
            throw new Error("the join authored no value marker for D1");
        }
        expect(journalRecordIdToString(markerD1.scope.value)).toBe(canonicalValueIdOf(artifact, 1));
        expect(valueMarkerOf(joined.records, 2)).toBeUndefined();
        const markerK = valueMarkerOf(joined.records, 3);
        expect(markerK).toBeDefined();
        if (markerK === undefined || markerK.scope.kind !== "value") {
            throw new Error("the join authored no value marker for K");
        }
        expect(journalRecordIdToString(markerK.scope.value)).toBe(canonicalValueIdOf(artifact, 3));
        expect(journalAuthorToString(markerK.id.author)).toBe(JOINER);
        expect(markerK.reason).toBe("bootstrap");
        const selectedD1 = occurrenceOf(joined.projection, 1);
        const selectedD2 = occurrenceOf(joined.projection, 2);
        const selectedK = occurrenceOf(joined.projection, 3);
        expect(selectedD1.fresh).toBe(false);
        expect(selectedD2.fresh).toBe(true);
        expect(selectedK.fresh).toBe(false);
        // K's proof stays valid against both canonical inputs; only its
        // persistent freshness is stale, solely through D1.
        expect([...selectedK.validInputs].sort()).toEqual([nodeKeyOf(1), nodeKeyOf(2)].sort());
    });
});
