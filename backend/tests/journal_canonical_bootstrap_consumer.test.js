"use strict";

/**
 * The two consumers `incremental-graph-journal-migrations.md` hands an arbitration
 * outcome to: §6 `resumeCanonicalBootstrapCreator` and §7 `joinCanonicalBootstrap`.
 *
 * The properties under test are the ones the specification makes load-bearing and
 * which the arbitration surface alone cannot establish:
 *
 * - §6: the resume installs exactly the artifact's own cut, refuses any artifact
 *   whose creator is not this replica's fingerprint, and fails
 *   `JournalBootstrapForkError` on a mismatch of occurrence fields, allocator state,
 *   or freshness. Freshness is compared as the reading both sides derive under the
 *   Journal rule, so a supported source which persisted `upToDate: true` above a
 *   stale certified input resumes rather than forking, and a genuine divergence in
 *   stale evidence forks.
 * - §7: an exact-shared occurrence keeps its canonical `ValueId` and authors no
 *   value, a joining-only occurrence becomes a historical value under the §7.1
 *   own-writer context exception, no `DeleteEvent` exists for a canonical node the
 *   joining graph does not materialize, local proof names the joining occurrences it
 *   actually depended on, canonical-only proof edges become proof-scoped barriers,
 *   shared stale evidence is the conservative OR of both sides, recursive-only
 *   staleness is persisted, and the joining allocator state stays local.
 */

const {
    arbitrateCanonicalBootstrap,
    isJoinedCanonicalBootstrap,
    isResumedCanonicalCreator,
    joinCanonicalBootstrap,
    makeCanonicalBootstrapSnapshot,
    makeCohortBootstrapSource,
    readLegacyBootstrapState,
    resumeCanonicalBootstrapCreator,
    stageCanonicalBootstrap,
} = require("../src/generators/incremental_graph/journal/bootstrap");

const {
    isJournalBootstrapForkError,
    journalAuthorToString,
    journalRecordIdToString,
    makeJournalAuthor,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const CREATOR = "aaaaaaaaa";
const JOINER = "bbbbbbbbb";
const GRAPH_SCHEME = "incremental-graph-default";
const CREATED_AT = "2020-01-01T00:00:00.000Z";
const EARLY = "2020-01-02T00:00:00.000Z";
const MIDDLE = "2020-02-02T00:00:00.000Z";
const LATE = "2020-03-04T00:00:00.000Z";
const OLDER = "2019-12-01T00:00:00.000Z";
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
    return { candidate, artifact };
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
 * The canonical artifact a cohort holds: node 1 is legacy-stale and node 2 depends
 * on it, so the cut exercises value, certificate, invalidation and writer state.
 * @returns {{legacyState: object, candidate: object, artifact: object}}
 */
function canonicalCohort() {
    const legacyState = sourceOf(
        persistedState([
            persistedNode(1, { upToDate: false }),
            persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
        ])
    );
    const { candidate, artifact } = artifactFrom(legacyState, CREATOR);
    return { legacyState, candidate, artifact };
}

describe("canonical creator resume of the §6 procedure", () => {
    test("installs exactly the artifact's own cut and reconstructs its state", () => {
        const { legacyState, artifact } = canonicalCohort();
        const resumed = resumeCanonicalBootstrapCreator({
            legacyState,
            artifact,
            localWriter: makeJournalAuthor(CREATOR),
            currentInputKeysOfNode: schemaOf([legacyState]),
        });
        expect(isResumedCanonicalCreator(resumed)).toBe(true);
        if (resumed instanceof Error) {
            return;
        }
        expect(resumed.records).toEqual(artifact.records);
        expect([...resumed.frontier]).toEqual([...artifact.bootstrapFrontier]);
        expect(resumed.databaseVersion).toBe(TARGET_VERSION);
        expect(resumed.projection.lastNodeIndex).toBe(legacyState.lastNodeIndex);
        expect(resumed.projection.occurrences.map((occurrence) => occurrence.nodeKeyString)).toEqual([
            nodeKeyOf(1),
            nodeKeyOf(2),
        ]);
    });

    test("a different fingerprint cannot use creator-resume", () => {
        const { legacyState, artifact } = canonicalCohort();
        const refused = resumeCanonicalBootstrapCreator({
            legacyState,
            artifact,
            localWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schemaOf([legacyState]),
        });
        expect(isResumedCanonicalCreator(refused)).toBe(false);
        expect(String(refused)).toContain("joining path");
    });

    test("a persisted payload the artifact does not hold is a fork", () => {
        const { artifact } = canonicalCohort();
        const divergent = sourceOf(
            persistedState([
                persistedNode(1, { upToDate: false }),
                persistedNode(2, {
                    modifiedAt: LATE,
                    validInputs: [nodeKeyOf(1)],
                    payload: payloadOf(2, "a different occurrence"),
                }),
            ])
        );
        const forked = resumeCanonicalBootstrapCreator({
            legacyState: divergent,
            artifact,
            localWriter: makeJournalAuthor(CREATOR),
            currentInputKeysOfNode: schemaOf([divergent]),
        });
        expect(isJournalBootstrapForkError(forked)).toBe(true);
        expect(String(forked)).toContain("payload");
    });

    test("a persisted allocator watermark the artifact does not reconstruct is a fork", () => {
        const { artifact } = canonicalCohort();
        const divergent = sourceOf(
            persistedState(
                [
                    persistedNode(1, { upToDate: false }),
                    persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
                ],
                11
            )
        );
        const forked = resumeCanonicalBootstrapCreator({
            legacyState: divergent,
            artifact,
            localWriter: makeJournalAuthor(CREATOR),
            currentInputKeysOfNode: schemaOf([divergent]),
        });
        expect(isJournalBootstrapForkError(forked)).toBe(true);
        expect(String(forked)).toContain("allocator watermark");
    });

    test("derived freshness is compared, so a fresh persisted flag above a stale input is not a fork", () => {
        const { legacyState, artifact } = canonicalCohort();
        // The source persists node 2 as up to date, yet it projects as stale because
        // its only certified input is legacy-stale. Comparing derived freshness keeps
        // the faithful cut resumable.
        const resumed = resumeCanonicalBootstrapCreator({
            legacyState,
            artifact,
            localWriter: makeJournalAuthor(CREATOR),
            currentInputKeysOfNode: schemaOf([legacyState]),
        });
        if (resumed instanceof Error) {
            throw resumed;
        }
        expect(resumed.projection.occurrences.map((occurrence) => occurrence.fresh)).toEqual([
            false,
            false,
        ]);
    });

    test("stale evidence the persisted source implies but the artifact does not record is a fork", () => {
        const freshCut = sourceOf(
            persistedState([
                persistedNode(1),
                persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
            ])
        );
        const { artifact } = artifactFrom(freshCut, CREATOR);
        const staleSource = sourceOf(
            persistedState([
                persistedNode(1, { upToDate: false }),
                persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
            ])
        );
        const forked = resumeCanonicalBootstrapCreator({
            legacyState: staleSource,
            artifact,
            localWriter: makeJournalAuthor(CREATOR),
            currentInputKeysOfNode: schemaOf([staleSource]),
        });
        expect(isJournalBootstrapForkError(forked)).toBe(true);
        expect(String(forked)).toContain("fresh");
    });

    test("a materialization the artifact omits is a fork rather than a cutover", () => {
        const { artifact } = canonicalCohort();
        const wider = sourceOf(
            persistedState([
                persistedNode(1, { upToDate: false }),
                persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
                persistedNode(3, { modifiedAt: MIDDLE }),
            ])
        );
        const forked = resumeCanonicalBootstrapCreator({
            legacyState: wider,
            artifact,
            localWriter: makeJournalAuthor(CREATOR),
            currentInputKeysOfNode: schemaOf([wider]),
        });
        expect(isJournalBootstrapForkError(forked)).toBe(true);
        expect(String(forked)).toContain("materializes");
    });
});

describe("joining the canonical bootstrap of §7", () => {
    test("an exact-shared occurrence keeps its canonical ValueId and authors no value", () => {
        const { artifact } = canonicalCohort();
        const joining = sourceOf(
            persistedState(
                [
                    persistedNode(1, { upToDate: false }),
                    persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
                ],
                9
            )
        );
        const joined = joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schemaOf([joining]),
        });
        expect(isJoinedCanonicalBootstrap(joined)).toBe(true);
        if (joined instanceof Error) {
            return;
        }
        const canonical = artifact.records.filter((record) => record.kind === "value");
        const joinedValues = joined.records.filter(
            (record) => record.kind === "value" && journalAuthorToString(record.id.author) === JOINER
        );
        expect(joinedValues).toEqual([]);
        for (const occurrence of joined.projection.occurrences) {
            const shared = canonical.find(
                (record) => nodeKeyToCanonicalString(record.node) === occurrence.nodeKeyString
            );
            expect(journalAuthorToString(occurrence.valueId.author)).toBe(CREATOR);
            expect(journalRecordIdToString(occurrence.valueId)).toBe(
                journalRecordIdToString(shared.id)
            );
        }
    });

    test("a joining-only node becomes a historical value under the §7.1 context exception", () => {
        const { artifact } = canonicalCohort();
        const joining = sourceOf(
            persistedState(
                [
                    persistedNode(1, { upToDate: false }),
                    persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
                    persistedNode(3, { modifiedAt: MIDDLE }),
                    persistedNode(4, { modifiedAt: NEWER, validInputs: [nodeKeyOf(3)] }),
                ],
                9
            )
        );
        const joined = joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schemaOf([joining]),
        });
        if (joined instanceof Error) {
            throw joined;
        }
        const historical = joined.records.filter(
            (record) =>
                record.kind === "value" && journalAuthorToString(record.id.author) === JOINER
        );
        expect(historical.map((record) => nodeKeyToCanonicalString(record.node))).toEqual([
            nodeKeyOf(3),
            nodeKeyOf(4),
        ]);
        // The §7.1 exception omits synthetic canonical-writer causality, so a
        // historical value's context is the exact own-writer prefix and never names
        // the canonical creator: the old legacy occurrence stays concurrent with the
        // canonical cut.
        for (const value of historical) {
            expect(
                [...value.context].every((entry) => journalAuthorToString(entry[0]) === JOINER)
            ).toBe(true);
        }
        expect([...historical[1].context]).toEqual([
            [historical[1].id.author, historical[0].id.sequence],
        ]);
        // The first historical value sits at the first own-writer coordinate, so its
        // own-writer prefix is frontier zero and it names no writer at all.
        expect([...historical[0].context]).toEqual([]);
        expect(historical.map((record) => record.reason)).toEqual(["bootstrap", "bootstrap"]);
        expect(historical.map((record) => record.modifiedAt)).toEqual([MIDDLE, NEWER]);
        const proof = joined.records.find(
            (record) =>
                record.kind === "validate" &&
                journalAuthorToString(record.id.author) === JOINER &&
                nodeKeyToCanonicalString(record.node) === nodeKeyOf(4)
        );
        expect([...proof.context].map((entry) => journalAuthorToString(entry[0])).sort()).toEqual(
            [CREATOR, JOINER].sort()
        );
        // A canonical node the joining graph does not materialize is not a deletion.
        expect(joined.records.some((record) => record.kind === "delete")).toBe(false);
    });

    test("a conflicting joining occurrence wins ordinary authority and survives", () => {
        const { artifact } = canonicalCohort();
        const joining = sourceOf(
            persistedState(
                [
                    persistedNode(1, { upToDate: false }),
                    persistedNode(2, { modifiedAt: NEWER, validInputs: [nodeKeyOf(1)] }),
                ],
                9
            )
        );
        const joined = joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schemaOf([joining]),
        });
        if (joined instanceof Error) {
            throw joined;
        }
        const selected = joined.projection.occurrences.find(
            (occurrence) => occurrence.nodeKeyString === nodeKeyOf(2)
        );
        expect(selected.modifiedAt).toBe(NEWER);
        expect(journalAuthorToString(selected.valueId.author)).toBe(JOINER);
    });

    test("local proof names the joining occurrences it depended on, with the source's stale evidence", () => {
        const { artifact } = canonicalCohort();
        const joining = sourceOf(
            persistedState([
                persistedNode(1, { upToDate: false }),
                persistedNode(2, {
                    modifiedAt: LATE,
                    validInputs: [nodeKeyOf(1)],
                    payload: payloadOf(2, "the joining occurrence"),
                }),
            ], 9)
        );
        const joined = joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schemaOf([joining]),
        });
        if (joined instanceof Error) {
            throw joined;
        }
        const certificates = joined.records.filter(
            (record) => record.kind === "validate" && journalAuthorToString(record.id.author) === JOINER
        );
        const second = certificates.find(
            (record) => nodeKeyToCanonicalString(record.node) === nodeKeyOf(2)
        );
        expect(second.basis).toHaveLength(1);
        // The joining occurrence of node 1 is exact-shared, so the basis names the
        // canonical ValueId of that occurrence.
        expect(journalAuthorToString(second.basis[0].value.author)).toBe(CREATOR);
        expect(journalRecordIdToString(second.basis[0].value)).toBe(
            journalRecordIdToString(artifact.records[0].id)
        );
    });

    test("a losing joining input occurrence retires the local proof edge instead of manufacturing it", () => {
        const { artifact } = canonicalCohort();
        const joining = sourceOf(
            persistedState(
                [
                    persistedNode(1, {
                        modifiedAt: OLDER,
                        payload: payloadOf(1, "older locally"),
                    }),
                    persistedNode(2, {
                        modifiedAt: NEWER,
                        validInputs: [nodeKeyOf(1)],
                        payload: payloadOf(2, "the joining occurrence"),
                    }),
                ],
                9
            )
        );
        const joined = joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schemaOf([joining]),
        });
        if (joined instanceof Error) {
            throw joined;
        }
        const certificate = joined.records.find(
            (record) =>
                record.kind === "validate" &&
                journalAuthorToString(record.id.author) === JOINER &&
                nodeKeyToCanonicalString(record.node) === nodeKeyOf(2)
        );
        expect(journalAuthorToString(certificate.basis[0].value.author)).toBe(JOINER);
        const selectedSecond = joined.projection.occurrences.find(
            (occurrence) => occurrence.nodeKeyString === nodeKeyOf(2)
        );
        // The canonical occurrence of node 1 wins authority, so the joining basis names
        // a ValueId replay does not select and node 2 is hard stale rather than fresh.
        expect(selectedSecond.fresh).toBe(false);
        expect([...selectedSecond.validInputs]).toEqual([]);
    });

    test("a locally authored stale occurrence carries its own persisted stale evidence", () => {
        const { artifact } = canonicalCohort();
        const joining = sourceOf(
            persistedState(
                [
                    persistedNode(1, { upToDate: false }),
                    persistedNode(2, {
                        modifiedAt: NEWER,
                        upToDate: false,
                        validInputs: [],
                        payload: payloadOf(2, "the joining occurrence"),
                    }),
                ],
                9
            )
        );
        const joined = joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schemaOf([joining]),
        });
        if (joined instanceof Error) {
            throw joined;
        }
        const value = joined.records.find(
            (record) =>
                record.kind === "value" &&
                journalAuthorToString(record.id.author) === JOINER &&
                nodeKeyToCanonicalString(record.node) === nodeKeyOf(2)
        );
        const stale = joined.records.find(
            (record) =>
                record.kind === "invalidate" &&
                journalAuthorToString(record.id.author) === JOINER &&
                nodeKeyToCanonicalString(record.node) === nodeKeyOf(2)
        );
        expect(stale.scope.kind).toBe("value");
        expect(journalRecordIdToString(stale.scope.value)).toBe(journalRecordIdToString(value.id));
        expect(stale.reason).toBe("bootstrap");
        expect(journalAuthorToString(stale.id.author)).toBe(JOINER);
        // The occurrence has no direct input at all, so its staleness is the direct
        // evidence the joining legacy graph persisted and nothing propagates into it.
        const selected = joined.projection.occurrences.find(
            (occurrence) => occurrence.nodeKeyString === nodeKeyOf(2)
        );
        expect(selected.fresh).toBe(false);
    });

    test("a canonical-only validity edge becomes a proof-scoped barrier", () => {
        const { artifact } = canonicalCohort();
        const joining = sourceOf(
            persistedState(
                [
                    persistedNode(1, { upToDate: false }),
                    persistedNode(2, { modifiedAt: LATE, validInputs: [] }),
                ],
                9
            )
        );
        const joined = joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schemaOf([joining]),
        });
        if (joined instanceof Error) {
            throw joined;
        }
        const barriers = joined.records.filter(
            (record) => record.kind === "invalidate" && record.scope.kind === "proof"
        );
        expect(barriers).toHaveLength(1);
        expect(nodeKeyToCanonicalString(barriers[0].scope.input)).toBe(nodeKeyOf(1));
        expect(journalAuthorToString(barriers[0].scope.value.author)).toBe(CREATOR);
        const selectedSecond = joined.projection.occurrences.find(
            (occurrence) => occurrence.nodeKeyString === nodeKeyOf(2)
        );
        expect([...selectedSecond.validInputs]).toEqual([]);
    });

    test("shared stale evidence is the conservative OR of both sides", () => {
        const freshCohort = sourceOf(
            persistedState([
                persistedNode(1),
                persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
            ])
        );
        const { artifact } = artifactFrom(freshCohort, CREATOR);
        const joining = sourceOf(
            persistedState(
                [
                    persistedNode(1, { upToDate: false }),
                    persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
                ],
                9
            )
        );
        const joined = joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schemaOf([joining, freshCohort]),
        });
        if (joined instanceof Error) {
            throw joined;
        }
        // A fresh joiner cannot clear the canonical basis, and a stale joiner stales
        // the canonical-fresh shared occurrence of node 1.
        const selected = joined.projection.occurrences.find(
            (occurrence) => occurrence.nodeKeyString === nodeKeyOf(1)
        );
        expect(selected.fresh).toBe(false);
        expect(
            joined.records.some(
                (record) =>
                    record.kind === "invalidate" &&
                    record.scope.kind === "value" &&
                    journalAuthorToString(record.scope.value.author) === CREATOR
            )
        ).toBe(true);
    });

    test("recursive-only staleness is persisted for a dependent of a stale occurrence", () => {
        const { artifact } = canonicalCohort();
        const joining = sourceOf(
            persistedState(
                [
                    persistedNode(1, { upToDate: false }),
                    persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
                ],
                9
            )
        );
        const joined = joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schemaOf([joining]),
        });
        if (joined instanceof Error) {
            throw joined;
        }
        const second = joined.records.filter(
            (record) =>
                record.kind === "invalidate" &&
                nodeKeyToCanonicalString(record.node) === nodeKeyOf(2)
        );
        expect(second.length).toBeGreaterThan(0);
        expect(second[0].scope.kind).toBe("value");
        expect(journalAuthorToString(second[0].scope.value.author)).toBe(CREATOR);
    });

    test("the joining writer keeps its own identity and allocator state", () => {
        const { artifact } = canonicalCohort();
        const joining = sourceOf(
            persistedState(
                [
                    persistedNode(1, { upToDate: false }),
                    persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
                    persistedNode(3, { modifiedAt: MIDDLE }),
                ],
                9
            )
        );
        const joined = joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schemaOf([joining]),
        });
        if (joined instanceof Error) {
            throw joined;
        }
        expect(joined.projection.lastNodeIndex).toBe(9);
        const writerStates = joined.records.filter(
            (record) =>
                record.kind === "writer-state" && journalAuthorToString(record.id.author) === JOINER
        );
        expect(writerStates).toHaveLength(1);
        expect(writerStates[0].lastNodeIndex).toBe(9);
        expect(journalAuthorToString(joined.joiningWriter)).toBe(JOINER);
        expect([...joined.frontier].map((entry) => journalAuthorToString(entry[0])).sort()).toEqual(
            [CREATOR, JOINER].sort()
        );
    });

    test("a joining fingerprint which authored the canonical cut cannot join it", () => {
        const { legacyState, artifact } = canonicalCohort();
        const refused = joinCanonicalBootstrap({
            legacyState,
            artifact,
            joiningWriter: makeJournalAuthor(CREATOR),
            currentInputKeysOfNode: schemaOf([legacyState]),
        });
        expect(isJoinedCanonicalBootstrap(refused)).toBe(false);
        expect(String(refused)).toContain("resumes it");
    });
});

describe("what the consumers do with an arbitration outcome", () => {
    test("a published artifact this replica did not stage cannot be resumed", async () => {
        const { legacyState } = canonicalCohort();
        const foreign = artifactFrom(sourceOf(persistedState([persistedNode(5)])), JOINER).artifact;
        const source = makeCohortBootstrapSource({
            queryCanonicalBootstrap: () => foreign,
            publishCanonicalBootstrapIfAbsent: () => {
                throw new Error("no publication may be attempted when an artifact exists");
            },
        });
        const outcome = await arbitrateCanonicalBootstrap({
            source,
            localWriter: makeJournalAuthor(CREATOR),
            target: { databaseVersion: TARGET_VERSION, graphSchemeString: GRAPH_SCHEME },
            stageCandidate: () => {
                throw new Error("an existing artifact must not be restaged");
            },
        });
        expect(outcome.operation).toBe("join-canonical-bootstrap");
        const refused = resumeCanonicalBootstrapCreator({
            legacyState,
            artifact: outcome.artifact,
            localWriter: makeJournalAuthor(CREATOR),
            currentInputKeysOfNode: schemaOf([legacyState]),
        });
        expect(isResumedCanonicalCreator(refused)).toBe(false);
    });

    test("an indeterminate publication cuts nothing over", async () => {
        const { legacyState, candidate } = canonicalCohort();
        /** @type {object[]} */
        const published = [];
        const source = makeCohortBootstrapSource({
            queryCanonicalBootstrap: () => null,
            publishCanonicalBootstrapIfAbsent: (staged) => {
                published.push(staged);
                return { detail: "the write timed out" };
            },
        });
        const outcome = await arbitrateCanonicalBootstrap({
            source,
            localWriter: makeJournalAuthor(CREATOR),
            target: { databaseVersion: TARGET_VERSION, graphSchemeString: GRAPH_SCHEME },
            stageCandidate: () => candidate,
        });
        expect(outcome.kind).toBe("unresolved-publication");
        expect(outcome.artifact).toBeUndefined();
        // The conditional publication was still attempted once, and the outcome stays
        // unresolved, so no consumer receives an artifact to install.
        expect(published).toEqual([candidate]);
        expect(isResumedCanonicalCreator(legacyState)).toBe(false);
        expect(isJoinedCanonicalBootstrap(outcome)).toBe(false);
    });

    test("a cutover authorized by publication is resumable by the creator", async () => {
        const { legacyState, artifact, candidate } = canonicalCohort();
        const source = makeCohortBootstrapSource({
            queryCanonicalBootstrap: () => null,
            publishCanonicalBootstrapIfAbsent: () => ({ published: true, artifact }),
        });
        const outcome = await arbitrateCanonicalBootstrap({
            source,
            localWriter: makeJournalAuthor(CREATOR),
            target: { databaseVersion: TARGET_VERSION, graphSchemeString: GRAPH_SCHEME },
            stageCandidate: () => candidate,
        });
        expect(outcome.kind).toBe("cut-over-to-local-creator");
        const resumed = resumeCanonicalBootstrapCreator({
            legacyState,
            artifact: outcome.artifact,
            localWriter: makeJournalAuthor(CREATOR),
            currentInputKeysOfNode: schemaOf([legacyState]),
        });
        expect(isResumedCanonicalCreator(resumed)).toBe(true);
    });
});

