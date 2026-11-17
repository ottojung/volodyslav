"use strict";

/**
 * `incremental-graph-journal-testing.md` §Exact shared stale is symmetric
 * (lines 629-654).
 *
 * For an exact-shared occurrence `V` the join must not let a fresh joining legacy
 * side clear stale evidence the canonical cut already holds, and must not let a
 * stale joining legacy side be cleared by the canonical cut. The specification
 * fixes this as the conservative OR of both sides' direct stale evidence:
 *
 * - Case A: canonical exact `V` fresh, joining exact `V` stale -> joined `V` is
 *   persistently stale. The existing `journal_canonical_bootstrap_consumer` test
 *   "shared stale evidence is the conservative OR of both sides" exercises this
 *   direction: the join authors a value-scoped `InvalidateEvent` naming the
 *   canonical `ValueId` because the joining side persisted direct stale evidence.
 *
 * - Case B (this file): canonical exact `V` stale, joining exact `V` fresh with a
 *   complete local proof -> the joining proof must not strengthen or replace the
 *   canonical proof, and `V` remains persistently stale because the canonical
 *   cut's own value-scoped bootstrap invalidation is uncovered by that concurrent
 *   joining proof. The canonical value-scoped invalidation keeps `V` stale without
 *   removing `V`'s incoming validity edge, and a dependent of `V` is recursively
 *   stale as well.
 *
 * Both tests drive the real `joinCanonicalBootstrap` consumer and read the derived
 * projection the replay oracle produces, so they pin the specified merge behavior
 * rather than an adapter's summary of it.
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
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const CREATOR = "aaaaaaaaa";
const JOINER = "bbbbbbbbb";
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
 * @returns {{candidate: object, artifact: object}}
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
 * The current graph schema implied by a set of legacy graphs: a node's direct
 * inputs are the union of the direct legacy inputs either replica persisted for it.
 *
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
 * @param {object} joined
 * @param {number} id
 * @returns {object | undefined}
 */
function canonicalValueOf(joined, id) {
    return joined.records.find(
        (record) => record.kind === "value" && nodeKeyToCanonicalString(record.node) === nodeKeyOf(id)
    );
}

/**
 * @param {object} joined
 * @param {number} id
 * @returns {object | undefined}
 */
function selectedOf(joined, id) {
    return joined.projection.occurrences.find(
        (occurrence) => occurrence.nodeKeyString === nodeKeyOf(id)
    );
}

describe("exact shared stale is symmetric, the canonical-stale direction", () => {
    test("a stale canonical leaf is not freshened by a fresh joiner", async () => {
        // The canonical cut holds node 1 as a legacy-stale occurrence, so its Pass C3
        // value-scoped bootstrap invalidation is already part of the artifact.
        const canonical = sourceOf(
            persistedState([
                persistedNode(1, { upToDate: false }),
                persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
            ])
        );
        const { artifact } = artifactFrom(canonical, CREATOR);
        // The joining legacy graph holds the exact same node 1 occurrence, but fresh.
        const joining = sourceOf(
            persistedState(
                [
                    persistedNode(1),
                    persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
                ],
                9
            )
        );
        const joined = await joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schemaOf([joining, canonical]),
        });
        if (joined instanceof Error) {
            throw joined;
        }
        expect(isJoinedCanonicalBootstrap(joined)).toBe(true);

        const canonicalFirst = canonicalValueOf(joined, 1);
        const selectedFirst = selectedOf(joined, 1);
        // The exact-shared occurrence keeps the canonical ValueId.
        expect(journalAuthorToString(selectedFirst.valueId.author)).toBe(CREATOR);
        expect(journalRecordIdToString(selectedFirst.valueId)).toBe(
            journalRecordIdToString(canonicalFirst.id)
        );
        // The fresh joining side cannot clear the canonical direct stale evidence.
        expect(selectedFirst.fresh).toBe(false);
        // The canonical value-scoped bootstrap invalidation is the one that applies,
        // and the join authors no duplicate or strengthening replacement for it.
        const invalidationsForV1 = joined.records.filter(
            (record) =>
                record.kind === "invalidate" &&
                record.scope.kind === "value" &&
                journalRecordIdToString(record.scope.value) ===
                    journalRecordIdToString(canonicalFirst.id)
        );
        expect(invalidationsForV1).toHaveLength(1);
        expect(journalAuthorToString(invalidationsForV1[0].id.author)).toBe(CREATOR);
        // The joining proof cannot strengthen or replace the canonical proof: no
        // joining validation is authored for the exact-shared occurrence.
        expect(
            joined.records.some(
                (record) =>
                    record.kind === "validate" &&
                    journalAuthorToString(record.id.author) === JOINER &&
                    nodeKeyToCanonicalString(record.node) === nodeKeyOf(1)
            )
        ).toBe(false);
        // The dependent of the stale exact-shared occurrence is recursively stale.
        expect(selectedOf(joined, 2).fresh).toBe(false);
    });

    test("a stale canonical dependent keeps its validity edge but stays stale", async () => {
        // Node 2 is directly legacy-stale on the canonical side and carries the
        // canonical D -> K validity edge; the joining side holds the exact same
        // occurrence fresh with the same complete local proof.
        const canonical = sourceOf(
            persistedState([
                persistedNode(1),
                persistedNode(2, { modifiedAt: LATE, upToDate: false, validInputs: [nodeKeyOf(1)] }),
            ])
        );
        const { artifact } = artifactFrom(canonical, CREATOR);
        const joining = sourceOf(
            persistedState(
                [
                    persistedNode(1),
                    persistedNode(2, { modifiedAt: LATE, upToDate: true, validInputs: [nodeKeyOf(1)] }),
                ],
                9
            )
        );
        const joined = await joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schemaOf([joining, canonical]),
        });
        if (joined instanceof Error) {
            throw joined;
        }
        expect(isJoinedCanonicalBootstrap(joined)).toBe(true);

        const canonicalSecond = canonicalValueOf(joined, 2);
        const selectedSecond = selectedOf(joined, 2);
        // The exact-shared occurrence keeps the canonical ValueId.
        expect(journalAuthorToString(selectedSecond.valueId.author)).toBe(CREATOR);
        expect(journalRecordIdToString(selectedSecond.valueId)).toBe(
            journalRecordIdToString(canonicalSecond.id)
        );
        // The joining complete local proof does not strengthen or replace the
        // canonical proof, and the canonical value-scoped invalidation keeps V stale.
        expect(selectedSecond.fresh).toBe(false);
        expect(
            joined.records.some(
                (record) =>
                    record.kind === "validate" &&
                    journalAuthorToString(record.id.author) === JOINER &&
                    nodeKeyToCanonicalString(record.node) === nodeKeyOf(2)
            )
        ).toBe(false);
        const invalidationsForV2 = joined.records.filter(
            (record) =>
                record.kind === "invalidate" &&
                record.scope.kind === "value" &&
                journalRecordIdToString(record.scope.value) ===
                    journalRecordIdToString(canonicalSecond.id)
        );
        expect(invalidationsForV2).toHaveLength(1);
        expect(journalAuthorToString(invalidationsForV2[0].id.author)).toBe(CREATOR);
        // A value-scoped invalidation affects persistent freshness but does not
        // remove the occurrence's incoming validity proof, so the D -> K edge
        // survives even though V is stale.
        expect([...selectedSecond.validInputs]).toEqual([nodeKeyOf(1)]);
    });
});
