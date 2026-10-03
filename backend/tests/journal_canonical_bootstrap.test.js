"use strict";

/**
 * The canonical-bootstrap path of `incremental-graph-journal-migrations.md`
 * Part I: the supported pre-Journal source boundary (§1), the immutable canonical
 * artifact (§3), the deterministic staging of passes C1–C4 (§5), and the
 * conditional-publication arbitration of `CohortBootstrapSource` (§4).
 *
 * These tests drive the pure path directly, with a transport held in memory, so
 * every assertion is about the specified decision rather than about an adapter.
 * The properties under test are the ones the specification makes load-bearing:
 *
 * - §1: an unsupported persisted identifier makes the whole source unsupported and
 *   is never re-minted;
 * - §5: staging is a pure function of persisted legacy state, allocates C1 by
 *   `(modifiedAt, canonical NodeKey)`, gives every C2/C3 record authority strictly
 *   above every C1 record, names the source's own persisted identifier, and records
 *   exactly one basis entry per direct legacy input;
 * - §3: an artifact is admitted only on exact equality with the configured
 *   bootstrap target, and its frontier must be a function of its own records;
 * - §4: publication, not the query, arbitrates — an absence still publishes, a
 *   published artifact which is not the published form of the staged candidate
 *   refuses cutover, `AlreadyExists` selects the winning artifact instead, and any
 *   indeterminate answer leaves the outcome unresolved without authoring anything.
 */

const {
    arbitrateCanonicalBootstrap,
    artifactSupportsBootstrapTarget,
    isCanonicalBootstrapDefinitelyAbsent,
    isCanonicalBootstrapExists,
    isCanonicalBootstrapIndeterminate,
    isCohortBootstrapSource,
    makeCanonicalBootstrapSnapshot,
    makeCohortBootstrapSource,
    publishedArtifactIsStagedCandidate,
    readLegacyBootstrapState,
    stageCanonicalBootstrap,
} = require("../src/generators/incremental_graph/journal/bootstrap");

const {
    isJournalBootstrapForkError,
    isJournalVersionCompatibilityError,
    compareAuthorityTime,
    journalAuthorToString,
    makeJournalAuthor,
    makeJournalFrontier,
    makeJournalSequence,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const {
    canonicalArtifactReplica,
} = require("../src/generators/incremental_graph/journal/bootstrap");

const {
    makeReplicaSource,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal/oracle");


const CREATOR = "aaaaaaaaa";
const GRAPH_SCHEME = "incremental-graph-default";
const CREATED_AT = "2020-01-01T00:00:00.000Z";
const EARLY = "2020-01-02T00:00:00.000Z";
const LATE = "2020-03-04T00:00:00.000Z";
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
 * @param {unknown} extra
 * @returns {object}
 */
function payloadOf(id, extra) {
    return { type: "entry_description", description: "entry " + String(id), ...extra };
}

/**
 * The persisted pre-Journal replica state, in the weak shape storage holds.
 * @param {object} overrides
 * @returns {object}
 */
function persistedState(overrides) {
    return {
        graphSchemeString: GRAPH_SCHEME,
        lastNodeIndex: 7,
        nodes: [
            {
                nodeKeyString: nodeKeyOf(2),
                nodeIdentifier: identifierOf(2),
                payload: payloadOf(2, {}),
                createdAt: CREATED_AT,
                modifiedAt: LATE,
                upToDate: true,
                validInputs: [nodeKeyOf(1)],
            },
            {
                nodeKeyString: nodeKeyOf(1),
                nodeIdentifier: identifierOf(1),
                payload: payloadOf(1, {}),
                createdAt: CREATED_AT,
                modifiedAt: EARLY,
                upToDate: false,
                validInputs: [],
            },
        ],
        ...overrides,
    };
}

/**
 * A validated supported pre-Journal state, or a thrown failure when the persisted
 * replica is rejected.
 * @param {object} overrides
 * @returns {object}
 */
function sourceState(overrides) {
    const state = readLegacyBootstrapState(persistedState(overrides));
    if (state instanceof Error) {
        throw state;
    }
    return state;
}

/**
 * The staged candidate for `state`, or a thrown failure.
 * @param {object} state
 * @param {string} creator
 * @returns {object}
 */
function stagedOf(state, creator) {
    const candidate = stageCanonicalBootstrap({
        legacyState: state,
        creatorWriter: makeJournalAuthor(creator),
        targetVersion: TARGET_VERSION,
    });
    if (candidate instanceof Error) {
        throw candidate;
    }
    return candidate;
}

/**
 * The published artifact of `candidate`, or a thrown failure.
 * @param {object} candidate
 * @returns {object}
 */
function artifactOf(candidate) {
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
 * A cohort bootstrap source whose query and publication answer as the test tells
 * them to, recording the candidates it was asked to publish.
 * @param {object} behaviour
 * @param {unknown} behaviour.queryResult
 * @param {unknown} behaviour.publicationResult
 * @param {boolean} behaviour.queryThrows
 * @returns {object}
 */
function sourceOf(behaviour) {
    /** @type {object[]} */
    const published = [];
    const source = makeCohortBootstrapSource({
        queryCanonicalBootstrap: () => {
            if (behaviour.queryThrows) {
                throw new Error("the cohort storage is unreachable");
            }
            return behaviour.queryResult;
        },
        publishCanonicalBootstrapIfAbsent: (candidate) => {
            published.push(candidate);
            return behaviour.publicationResult;
        },
    });
    if (source instanceof Error) {
        throw source;
    }
    return { source, published };
}

const TARGET = { databaseVersion: TARGET_VERSION, graphSchemeString: GRAPH_SCHEME };

/**
 * @param {object} source
 * @param {object} candidate
 * @returns {Promise<object>}
 */
function arbitrate(source, candidate) {
    return arbitrateCanonicalBootstrap({
        source,
        localWriter: makeJournalAuthor(CREATOR),
        target: TARGET,
        stageCandidate: () => candidate,
    });
}

describe("the supported pre-Journal source boundary", () => {
    test("reads a supported replica into canonical persisted order", () => {
        const state = sourceState({});
        expect(state.nodes.map((node) => node.nodeKeyString)).toEqual([nodeKeyOf(1), nodeKeyOf(2)]);
        expect(state.lastNodeIndex).toBe(7);
        expect(state.graphSchemeString).toBe(GRAPH_SCHEME);
    });

    test("rejects a persisted identifier outside the supported domain without re-minting it", () => {
        const rejection = readLegacyBootstrapState(
            persistedState({
                nodes: [
                    {
                        nodeKeyString: nodeKeyOf(1),
                        nodeIdentifier: "not an identifier",
                        payload: payloadOf(1, {}),
                        createdAt: CREATED_AT,
                        modifiedAt: EARLY,
                        upToDate: true,
                        validInputs: [],
                    },
                ],
            })
        );
        expect(rejection instanceof Error).toBe(true);
        expect(isJournalVersionCompatibilityError(rejection)).toBe(true);
        expect(String(rejection)).toContain("not re-minted");
    });

    test("rejects two materialized nodes sharing one physical identifier", () => {
        const rejection = readLegacyBootstrapState(
            persistedState({
                nodes: [
                    {
                        nodeKeyString: nodeKeyOf(1),
                        nodeIdentifier: identifierOf(1),
                        payload: payloadOf(1, {}),
                        createdAt: CREATED_AT,
                        modifiedAt: EARLY,
                        upToDate: true,
                        validInputs: [],
                    },
                    {
                        nodeKeyString: nodeKeyOf(2),
                        nodeIdentifier: identifierOf(1),
                        payload: payloadOf(2, {}),
                        createdAt: CREATED_AT,
                        modifiedAt: LATE,
                        upToDate: true,
                        validInputs: [],
                    },
                ],
            })
        );
        expect(isJournalVersionCompatibilityError(rejection)).toBe(true);
    });
});

describe("deterministic canonical staging of passes C1 through C4", () => {
    test("allocates C1 by nondecreasing modifiedAt and transports persisted identifiers", () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        const values = candidate.records.filter((record) => record.kind === "value");
        expect(values.map((record) => record.node.args[0].id)).toEqual([1, 2]);
        expect(values.map((record) => record.nodeIdentifier)).toEqual([identifierOf(1), identifierOf(2)]);
        expect(values.map((record) => record.reason)).toEqual(["bootstrap", "bootstrap"]);
        expect(values.map((record) => record.createdAt)).toEqual([CREATED_AT, CREATED_AT]);
        expect(values.map((record) => record.modifiedAt)).toEqual([EARLY, LATE]);
    });

    test("gives every C2 and C3 record authority strictly above every C1 record", () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        const values = candidate.records.filter((record) => record.kind === "value");
        const rest = candidate.records.filter(
            (record) => record.kind !== "value" && record.kind !== "writer-state"
        );
        expect(rest.length).toBeGreaterThan(0);
        // §5.1: every C2/C3 authority is `{physical: H.physical, logical: H.logical + 1}`
        // above the greatest C1 authority, so no wall clock is consulted and the
        // order is strictly ascending in `(physical, logical)`.
        const c1Authorities = values.map((record) => record.authorityTime);
        const restAuthorities = rest.map((record) => record.authorityTime);
        expect(restAuthorities.length).toBeGreaterThan(1);
        for (const authority of restAuthorities) {
            expect(c1Authorities.every((seed) => compareAuthorityTime(authority, seed) > 0)).toBe(true);
        }
        for (const [position, authority] of restAuthorities.entries()) {
            if (position === 0) {
                continue;
            }
            expect(compareAuthorityTime(authority, restAuthorities[position - 1])).toBeGreaterThan(0);
        }
    });

    test("names one basis entry per direct legacy input and the source's own occurrence", () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        const valueIds = new Map(
            candidate.records
                .filter((record) => record.kind === "value")
                .map((record) => [record.node.args[0].id, record.id])
        );
        const certificates = candidate.records.filter((record) => record.kind === "validate");
        const byNode = new Map(certificates.map((record) => [record.node.args[0].id, record]));
        expect(certificates.map((record) => record.node.args[0].id)).toEqual([1, 2]);
        const second = byNode.get(2);
        expect(second.value).toBe(valueIds.get(2));
        expect(second.basis).toHaveLength(1);
        expect(second.basis[0].value).toBe(valueIds.get(1));
        expect(byNode.get(1).value).toBe(valueIds.get(1));
        expect(byNode.get(1).basis).toHaveLength(0);
    });

    test("records a legacy validity edge naming an unmaterialized input as unknown", () => {
        const candidate = stagedOf(
            sourceState({
                nodes: [
                    {
                        nodeKeyString: nodeKeyOf(1),
                        nodeIdentifier: identifierOf(1),
                        payload: payloadOf(1, {}),
                        createdAt: CREATED_AT,
                        modifiedAt: EARLY,
                        upToDate: true,
                        validInputs: [nodeKeyOf(9)],
                    },
                ],
            }),
            CREATOR
        );
        const certificate = candidate.records.find((record) => record.kind === "validate");
        expect(certificate.basis).toHaveLength(1);
        expect(certificate.basis[0].value).toBe("unknown");
    });

    test("invalidates exactly the legacy-stale node after its own certificate", () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        const kinds = candidate.records.map((record) => record.kind);
        expect(kinds).toEqual(["value", "value", "validate", "validate", "invalidate", "writer-state"]);
        const invalidation = candidate.records[4];
        expect(invalidation.node.args[0].id).toBe(1);
        expect(invalidation.scope).toEqual({ kind: "value", value: candidate.records[0].id });
    });

    test("records the creator's legacy allocator watermark as the last record", () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        const last = candidate.records[candidate.records.length - 1];
        expect(last.kind).toBe("writer-state");
        expect(last.lastNodeIndex).toBe(7);
    });

    test("is a pure function of persisted state, so a lost publication is retryable", () => {
        const first = stagedOf(sourceState({}), CREATOR);
        const second = stagedOf(sourceState({}), CREATOR);
        expect(second.records).toEqual(first.records);
        expect([...second.bootstrapFrontier]).toEqual([...first.bootstrapFrontier]);
    });

    test("replays to the legacy occurrences the source persists", () => {
        const state = sourceState({});
        const candidate = stagedOf(state, CREATOR);
        const projection = projectRetainedJournal({
            source: makeReplicaSource(canonicalArtifactReplica(artifactOf(candidate))),
            localWriter: candidate.creatorWriter,
            currentInputKeysOfNode: (nodeKeyString) => {
                const node = state.nodeAt(nodeKeyString);
                return node === undefined ? undefined : node.directInputKeys.map(nodeKeyToCanonicalString);
            },
        });
        expect(projection instanceof Error).toBe(false);
        const values = new Map(projection.occurrences.map((node) => [node.nodeKeyString, node]));
        expect([...values.keys()].sort()).toEqual([nodeKeyOf(1), nodeKeyOf(2)]);
        expect(values.get(nodeKeyOf(1)).nodeIdentifier).toBe(identifierOf(1));
        expect(values.get(nodeKeyOf(2)).nodeIdentifier).toBe(identifierOf(2));
        expect(values.get(nodeKeyOf(1)).payload).toEqual(payloadOf(1, {}));
        expect(values.get(nodeKeyOf(2)).payload).toEqual(payloadOf(2, {}));
        // Freshness is derived, not transported: node 1's own legacy-stale evidence
        // invalidates the certificate naming it, so node 2 projects as propagated
        // staleness even though the source persisted it as up to date. Bootstrap
        // records the evidence the source persisted and lets replay derive freshness
        // under the Journal rule.
        expect(values.get(nodeKeyOf(1)).fresh).toBe(false);
        expect(values.get(nodeKeyOf(2)).fresh).toBe(false);
        expect(projection.unmarkedPropagatedStaleness.has(nodeKeyOf(2))).toBe(true);
        expect(values.get(nodeKeyOf(1)).createdAt).toBe(CREATED_AT);
        expect(values.get(nodeKeyOf(2)).modifiedAt).toBe(LATE);
        expect([...values.get(nodeKeyOf(2)).validInputs]).toEqual([nodeKeyOf(1)]);
        expect(projection.lastNodeIndex).toBe(7);
    });

    test("freezes the candidate at the frontier its own records reach", () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        expect([...candidate.bootstrapFrontier]).toEqual([
            [candidate.creatorWriter, candidate.records[candidate.records.length - 1].id.sequence],
        ]);
    });
});

describe("the immutable canonical bootstrap artifact", () => {
    test("exposes exactly the staged cut and no later history", async () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        const artifact = artifactOf(candidate);
        expect(artifact.records).toHaveLength(candidate.records.length);
        expect(artifact.get(candidate.creatorWriter, candidate.records[0].id.sequence)).toBe(candidate.records[0]);
        const seen = [];
        for await (const record of artifact.iterate(
            candidate.creatorWriter,
            undefined,
            candidate.records[candidate.records.length - 1].id.sequence
        )) {
            seen.push(record);
        }
        expect(seen).toEqual(candidate.records);
    });

    test("rejects a claimed frontier the held records do not reach", () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        const rejection = makeCanonicalBootstrapSnapshot({
            records: candidate.records,
            creatorWriter: candidate.creatorWriter,
            bootstrapFrontier: makeJournalFrontier([[candidate.creatorWriter, makeJournalSequence("999")]]),
            databaseVersion: TARGET_VERSION,
            graphSchemeString: GRAPH_SCHEME,
        });
        expect(rejection instanceof Error).toBe(true);
    });

    test("is admitted only on exact equality with the configured bootstrap target", () => {
        const artifact = artifactOf(stagedOf(sourceState({}), CREATOR));
        expect(artifactSupportsBootstrapTarget(artifact, TARGET)).toBeUndefined();
        expect(
            isJournalVersionCompatibilityError(
                artifactSupportsBootstrapTarget(artifact, {
                    databaseVersion: "4",
                    graphSchemeString: GRAPH_SCHEME,
                })
            )
        ).toBe(true);
        expect(
            isJournalVersionCompatibilityError(
                artifactSupportsBootstrapTarget(artifact, {
                    databaseVersion: TARGET_VERSION,
                    graphSchemeString: "some-other-scheme",
                })
            )
        ).toBe(true);
    });
});

describe("the conditional-publication arbitration", () => {
    test("an absent slot still publishes conditionally instead of cutting over", async () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        const { source, published } = sourceOf({
            queryResult: null,
            publicationResult: { published: true, artifact: artifactOf(candidate) },
        });
        const outcome = await arbitrate(source, candidate);
        expect(outcome.kind).toBe("cut-over-to-local-creator");
        expect(publishedArtifactIsStagedCandidate(outcome.artifact, candidate)).toBe(true);
        expect(outcome.candidate).toBe(candidate);
        expect(published).toEqual([candidate]);
    });

    test("a published artifact which is not the published form of the staged candidate refuses cutover", async () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        const foreign = stagedOf(
            sourceState({
                nodes: [
                    {
                        nodeKeyString: nodeKeyOf(1),
                        nodeIdentifier: identifierOf(1),
                        payload: payloadOf(1, { description: "a different occurrence" }),
                        createdAt: CREATED_AT,
                        modifiedAt: EARLY,
                        upToDate: true,
                        validInputs: [],
                    },
                ],
            }),
            CREATOR
        );
        const { source } = sourceOf({
            queryResult: null,
            publicationResult: { published: true, artifact: artifactOf(foreign) },
        });
        expect(publishedArtifactIsStagedCandidate(artifactOf(foreign), candidate)).toBe(false);
        const outcome = await arbitrate(source, candidate);
        expect(isJournalBootstrapForkError(outcome)).toBe(true);
    });

    test("AlreadyExists discards the losing candidate and joins the winning artifact", async () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        const winning = artifactOf(stagedOf(sourceState({}), "bbbbbbbbb"));
        const { source, published } = sourceOf({
            queryResult: null,
            publicationResult: { alreadyExists: true, artifact: winning },
        });
        const outcome = await arbitrate(source, candidate);
        expect(outcome.kind).toBe("use-canonical-artifact");
        expect(outcome.operation).toBe("join-canonical-bootstrap");
        expect(outcome.artifact).toBe(winning);
        expect(published).toEqual([candidate]);
    });

    test("an existing artifact routes creator-resume by its creator writer", async () => {
        const mine = artifactOf(stagedOf(sourceState({}), CREATOR));
        const theirs = artifactOf(stagedOf(sourceState({}), "bbbbbbbbb"));
        const { source, published } = sourceOf({ queryResult: mine, publicationResult: null });
        expect((await arbitrate(source, stagedOf(sourceState({}), CREATOR))).operation).toBe(
            "resume-canonical-creator"
        );
        const other = sourceOf({ queryResult: theirs, publicationResult: null });
        expect((await arbitrate(other.source, stagedOf(sourceState({}), CREATOR))).operation).toBe(
            "join-canonical-bootstrap"
        );
        expect(published).toEqual([]);
    });

    test("an indeterminate query fails startup and attempts no publication", async () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        const { source, published } = sourceOf({ queryThrows: true, publicationResult: null });
        const outcome = await arbitrate(source, candidate);
        expect(outcome.kind).toBe("unresolved-publication");
        expect(outcome.detail).toContain("unreachable");
        expect(published).toEqual([]);
    });

    test("an unrecognized query answer is indeterminate, never an absence", async () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        const { source, published } = sourceOf({ queryResult: "no idea", publicationResult: null });
        const outcome = await arbitrate(source, candidate);
        expect(outcome.kind).toBe("unresolved-publication");
        expect(published).toEqual([]);
    });

    test("an indeterminate publication leaves the outcome unresolved and cuts nothing over", async () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        const { source } = sourceOf({
            queryResult: null,
            publicationResult: { detail: "the write timed out" },
        });
        const outcome = await arbitrate(source, candidate);
        expect(outcome.kind).toBe("unresolved-publication");
        expect(outcome.artifact).toBeUndefined();
        expect(outcome.detail).toContain("re-querying");
    });

    test("a retry of an unknown outcome republishes the very candidate already staged", async () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        const { source, published } = sourceOf({
            queryResult: null,
            publicationResult: { published: true, artifact: artifactOf(candidate) },
        });
        let stageCalls = 0;
        const outcome = await arbitrateCanonicalBootstrap({
            source,
            localWriter: makeJournalAuthor(CREATOR),
            target: TARGET,
            stageCandidate: () => {
                stageCalls += 1;
                return stagedOf(sourceState({ nodes: [] }), CREATOR);
            },
            stagedCandidate: candidate,
        });
        expect(outcome.kind).toBe("cut-over-to-local-creator");
        expect(published).toEqual([candidate]);
        expect(stageCalls).toBe(0);
    });

    test("an artifact the running release does not join fails before any publication", async () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        const artifact = artifactOf(candidate);
        const { source, published } = sourceOf({ queryResult: artifact, publicationResult: null });
        const outcome = await arbitrateCanonicalBootstrap({
            source,
            localWriter: makeJournalAuthor(CREATOR),
            target: { databaseVersion: "4", graphSchemeString: GRAPH_SCHEME },
            stageCandidate: () => candidate,
        });
        expect(isJournalVersionCompatibilityError(outcome)).toBe(true);
        expect(published).toEqual([]);
    });

    test("a source is configured only when it answers both operations", () => {
        expect(isCohortBootstrapSource(makeCohortBootstrapSource({
            queryCanonicalBootstrap: () => null,
            publishCanonicalBootstrapIfAbsent: () => null,
        }))).toBe(true);
        expect(makeCohortBootstrapSource({ queryCanonicalBootstrap: () => null }) instanceof Error).toBe(true);
        expect(
            makeCohortBootstrapSource({
                queryCanonicalBootstrap: () => null,
                publishCanonicalBootstrapIfAbsent: () => null,
                reconcile: () => null,
            }) instanceof Error
        ).toBe(true);
    });

    test("the absence and indeterminate variants are distinguishable from an artifact", () => {
        const absent = sourceOf({ queryResult: null, publicationResult: null });
        expect(isCanonicalBootstrapDefinitelyAbsent(absent.source)).toBe(false);
        const candidate = stagedOf(sourceState({}), CREATOR);
        expect(isCanonicalBootstrapExists({ artifact: artifactOf(candidate) })).toBe(false);
        expect(isCanonicalBootstrapIndeterminate({ detail: "x" })).toBe(false);
        expect(isCanonicalBootstrapDefinitelyAbsent(null)).toBe(false);
    });

    test("a staged candidate carries the local fingerprint as its author", () => {
        const candidate = stagedOf(sourceState({}), CREATOR);
        expect(journalAuthorToString(candidate.creatorWriter)).toBe(CREATOR);
    });
});
