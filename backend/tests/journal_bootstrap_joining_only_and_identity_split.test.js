"use strict";

/**
 * Two uncovered cases of the Journal 3 legacy-conflict section of
 * `incremental-graph-journal-testing.md`:
 *
 * 1. §Exact shared proof intersection, the joining-only sub-bullet: when the
 *    joining legacy graph holds a validity edge the canonical cut does not, the
 *    join must not strengthen the exact-shared occurrence's canonical proof, so
 *    the joining-only edge remains absent. This is the converse of the
 *    canonical-only proof barrier, which the existing consumer tests already
 *    cover.
 *
 * 2. §Non-canonical identity-split trade-off: two independent late joiners may
 *    hold the same non-canonical legacy occurrence and each author its own
 *    bootstrap `ValueEvent`, assigning distinct `ValueId`s to what had been one
 *    materialization. After the prefix-union of the two joins, ordinary
 *    authority selects one of the two `ValueId`s, and a dependent certificate
 *    naming the loser stops matching, so the dependent is hard stale and must
 *    revalidate or recompute. This is the accepted `$id-1635227135166767`
 *    trade-off, exercised end-to-end through the joining procedure and the
 *    prefix-union oracle rather than asserted as a bare fact.
 *
 * Both cases drive `joinCanonicalBootstrap` with the same fixtures the
 * specification describes, and read the derived projection the oracle produces,
 * so the assertions are about the specified merge behavior rather than about an
 * adapter.
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
    makeJournalAuthor,
    makeJournalReplica,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const {
    makeReplicaSource,
    makeUnionSource,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal/oracle");

const CREATOR = "aaaaaaaaa";
const JOINER = "bbbbbbbbb";
const SECOND_JOINER = "ccccccccc";
const GRAPH_SCHEME = "incremental-graph-default";
const CREATED_AT = "2020-01-01T00:00:00.000Z";
const EARLY = "2020-01-02T00:00:00.000Z";
const LATE = "2020-03-04T00:00:00.000Z";
const NEWER = "2021-05-06T00:00:00.000Z";
const TARGET_VERSION = "3";

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
 * inputs are the union of the direct legacy inputs either replica persisted for
 * it.
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
 * A materialized replica over one record set, for the prefix-union source.
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
 * The selected occurrence of one node, which the assertions read.
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

describe("a joining-only proof edge never strengthens canonical proof", () => {
    test("an exact-shared occurrence keeps its canonical basis and the joining-only edge stays absent", async () => {
        // canonical: D exact-shared fresh; K exact-shared fresh with an empty canonical
        // basis, so the canonical cut holds no D -> K validity edge.
        const canonical = sourceOf(
            persistedState([
                persistedNode(1, { modifiedAt: EARLY }),
                persistedNode(2, { modifiedAt: LATE, validInputs: [] }),
            ])
        );
        const artifact = artifactFrom(canonical, CREATOR);
        // joining: the same D and K occurrences, but the joining legacy graph holds a
        // D -> K validity edge the canonical cut does not.
        const joining = sourceOf(
            persistedState(
                [
                    persistedNode(1, { modifiedAt: EARLY }),
                    persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
                ],
                9
            )
        );
        const schema = schemaOf([joining, canonical]);
        // Non-vacuity: the joining-only edge is genuinely present in the joining legacy
        // graph and is a direct input of K in the current schema.
        expect([...(schema(nodeKeyOf(2)) ?? [])]).toContain(nodeKeyOf(1));
        expect([...(schema(nodeKeyOf(2)) ?? [])]).toHaveLength(1);

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

        const canonicalK = artifact.records.find(
            (record) =>
                record.kind === "value" && nodeKeyToCanonicalString(record.node) === nodeKeyOf(2)
        );
        expect(canonicalK).toBeDefined();
        if (canonicalK === undefined) {
            return;
        }
        const selected = occurrenceOf(joined.projection, 2);
        // K is exact-shared, so it keeps the canonical ValueId and no joining value was
        // authored for it.
        expect(journalRecordIdToString(selected.valueId)).toBe(
            journalRecordIdToString(canonicalK.id)
        );
        // No joining ValidateEvent retargets or strengthens the exact-shared proof.
        expect(
            joined.records.some(
                (record) =>
                    record.kind === "validate" &&
                    journalAuthorToString(record.id.author) === JOINER &&
                    nodeKeyToCanonicalString(record.node) === nodeKeyOf(2)
            )
        ).toBe(false);
        // No proof-scoped barrier is authored for a joining-only edge: barriers retire
        // canonical edges the joining side lacks, and this edge goes the other way.
        expect(
            joined.records.some(
                (record) => record.kind === "invalidate" && record.scope.kind === "proof"
            )
        ).toBe(false);
        // The joining-only D -> K edge remains absent from the final projection.
        expect([...selected.validInputs]).toEqual([]);
        // The retained canonical proof does not cover the current input D, so the
        // exact-shared occurrence is hard stale rather than freshened by joining-only
        // proof.
        expect(selected.fresh).toBe(false);
    });
});

describe("the non-canonical identity-split trade-off", () => {
    test("two late joiners split the same non-canonical occurrence and the loser's dependent stale", async () => {
        // canonical: an older K occurrence.
        const canonical = sourceOf(
            persistedState([
                persistedNode(1, { modifiedAt: EARLY, payload: payloadOf(1, "canonical K") }),
            ])
        );
        const artifact = artifactFrom(canonical, CREATOR);

        // J1 and J2 both hold the SAME non-canonical newer K occurrence, so each authors
        // its own bootstrap ValueEvent. Each also holds a dependent M naming its own K;
        // J1's M is newer, so it wins M, while J2 wins K by the writer tie-break.
        const j1State = sourceOf(
            persistedState(
                [
                    persistedNode(1, { modifiedAt: NEWER, payload: payloadOf(1, "joining K") }),
                    persistedNode(2, {
                        modifiedAt: NEWER,
                        payload: payloadOf(2, "joining M"),
                        validInputs: [nodeKeyOf(1)],
                    }),
                ],
                9
            )
        );
        const j2State = sourceOf(
            persistedState(
                [
                    persistedNode(1, { modifiedAt: NEWER, payload: payloadOf(1, "joining K") }),
                    persistedNode(2, {
                        modifiedAt: LATE,
                        payload: payloadOf(2, "joining M"),
                        validInputs: [nodeKeyOf(1)],
                    }),
                ],
                11
            )
        );
        const schema = schemaOf([j1State, j2State, canonical]);

        const joined1 = await joinCanonicalBootstrap({
            legacyState: j1State,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schema,
        });
        const joined2 = await joinCanonicalBootstrap({
            legacyState: j2State,
            artifact,
            joiningWriter: makeJournalAuthor(SECOND_JOINER),
            currentInputKeysOfNode: schema,
        });
        expect(isJoinedCanonicalBootstrap(joined1)).toBe(true);
        expect(isJoinedCanonicalBootstrap(joined2)).toBe(true);
        if (joined1 instanceof Error) {
            throw joined1;
        }
        if (joined2 instanceof Error) {
            throw joined2;
        }

        const v1 = joined1.records.find(
            (record) =>
                record.kind === "value" &&
                journalAuthorToString(record.id.author) === JOINER &&
                nodeKeyToCanonicalString(record.node) === nodeKeyOf(1)
        );
        const v2 = joined2.records.find(
            (record) =>
                record.kind === "value" &&
                journalAuthorToString(record.id.author) === SECOND_JOINER &&
                nodeKeyToCanonicalString(record.node) === nodeKeyOf(1)
        );
        expect(v1).toBeDefined();
        expect(v2).toBeDefined();
        if (v1 === undefined || v2 === undefined) {
            return;
        }
        // Each late joiner independently assigned its own ValueId to the same legacy
        // occurrence, which differs from the canonical cut.
        expect(journalRecordIdToString(v1.id)).not.toBe(journalRecordIdToString(v2.id));
        expect(v1.nodeIdentifier).toEqual(v2.nodeIdentifier);
        expect(v1.payload).toEqual(v2.payload);
        expect(v1.createdAt).toEqual(v2.createdAt);
        expect(v1.modifiedAt).toEqual(v2.modifiedAt);
        const canonicalK = artifact.records.find(
            (record) =>
                record.kind === "value" && nodeKeyToCanonicalString(record.node) === nodeKeyOf(1)
        );
        expect(canonicalK).toBeDefined();
        if (canonicalK === undefined) {
            return;
        }
        expect(journalRecordIdToString(v1.id)).not.toBe(journalRecordIdToString(canonicalK.id));
        expect(journalRecordIdToString(v2.id)).not.toBe(journalRecordIdToString(canonicalK.id));

        // Union the two independent joins through the prefix-union source, which is how
        // the two late-join histories meet.
        const projection = await projectRetainedJournal({
            source: makeUnionSource([
                makeReplicaSource(replicaOf(joined1.records)),
                makeReplicaSource(replicaOf(joined2.records)),
            ]),
            localWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schema,
        });
        expect(projection instanceof Error).toBe(false);
        if (projection instanceof Error) {
            return;
        }

        const selectedK = occurrenceOf(projection, 1);
        // One of the two late-join ValueIds wins ordinary authority; the other is the
        // loser whose dependent may stale.
        const winner = journalRecordIdToString(selectedK.valueId);
        expect([journalRecordIdToString(v1.id), journalRecordIdToString(v2.id)]).toContain(winner);
        const loser = winner === journalRecordIdToString(v1.id) ? v2 : v1;

        // The dependent M selects J1's newer occurrence, whose certificate names the
        // losing K ValueId, so M is hard stale rather than freshened.
        const selectedM = occurrenceOf(projection, 2);
        const mFreshness = projection.freshness.get(nodeKeyOf(2));
        expect(mFreshness).toBeDefined();
        if (mFreshness === undefined) {
            return;
        }
        const mCertificate = mFreshness.certificate;
        expect(mCertificate).toBeDefined();
        if (mCertificate === undefined) {
            return;
        }
        expect(mCertificate.certificate.basis).toHaveLength(1);
        expect(journalRecordIdToString(mCertificate.certificate.basis[0].value)).toBe(
            journalRecordIdToString(loser.id)
        );
        expect(selectedM.fresh).toBe(false);
        expect([...selectedM.validInputs]).toEqual([]);

        // The losing ValueEvent survives as history; the split is not repaired by a
        // replacement ValueEvent.
        const losingRecords = [...joined1.records, ...joined2.records].filter(
            (record) =>
                record.kind === "value" &&
                journalRecordIdToString(record.id) === journalRecordIdToString(loser.id)
        );
        expect(losingRecords).toHaveLength(1);
    });
});
