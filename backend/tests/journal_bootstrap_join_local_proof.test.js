"use strict";

/**
 * `incremental-graph-journal-migrations.md` §7.3 (Locally authored occurrences)
 * and `incremental-graph-journal-user-contract.md` §Locally-authored dependent
 * proof require the bootstrap certificate of a locally authored joining
 * occurrence to record the historical proof the joining legacy graph actually
 * held, not the current schema's input merely because that input is materialized:
 *
 * > For each locally authored selected occurrence K, author a bootstrap
 * > ValidateEvent whose basis records the historical proof actually present in
 * > the joining legacy graph. For every direct input D: if joining legacy
 * > validity contains D -> K, use joiningOccurrenceValueId(D); otherwise use
 * > unknown.
 *
 * A joining occurrence whose legacy `D -> K` edge was removed (for example by a
 * pre-Journal explicit invalidation) must therefore record `"unknown"` for `D`.
 * Naming the materialized `D` occurrence would expose a validity edge no legacy
 * replica possessed.
 */

const {
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

const NODE_D = { head: "entry_description", args: [{ id: 1 }] };
const NODE_K = { head: "entry_description", args: [{ id: 2 }] };

/**
 * @param {object} node
 * @returns {string}
 */
function nodeKeyOf(node) {
    return nodeKeyToCanonicalString(node);
}

/**
 * @param {number} id
 * @param {object} [overrides]
 * @returns {object}
 */
function persistedNode(id, overrides) {
    return {
        nodeKeyString: nodeKeyOf({ head: "entry_description", args: [{ id }] }),
        nodeIdentifier: String(id) + "-abcdefghi",
        payload: { type: "entry_description", description: "entry " + String(id) },
        createdAt: CREATED_AT,
        modifiedAt: EARLY,
        upToDate: true,
        validInputs: [],
        ...overrides,
    };
}

/**
 * @param {ReadonlyArray<object>} nodes
 * @returns {object}
 */
function persistedState(nodes) {
    return { graphSchemeString: GRAPH_SCHEME, lastNodeIndex: 7, nodes };
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
 * @param {object} joiningState
 * @param {string} joiningWriter
 * @returns {Promise<object>}
 */
async function join(joiningState, joiningWriter) {
    const canonicalState = sourceOf(persistedState([
        persistedNode(1, { modifiedAt: EARLY }),
        persistedNode(2, {
            modifiedAt: EARLY,
            validInputs: [nodeKeyOf(NODE_D)],
            upToDate: true,
        }),
    ]));
    const artifact = artifactFrom(canonicalState, CREATOR);
    const result = await joinCanonicalBootstrap({
        legacyState: joiningState,
        artifact,
        joiningWriter: makeJournalAuthor(joiningWriter),
        currentInputKeysOfNode: schemaOf([canonicalState, joiningState]),
    });
    if (result instanceof Error) {
        throw result;
    }
    return result;
}

/**
 * The K certificate one writer authored for the locally authored joining
 * occurrence.
 * @param {object} result
 * @param {string} writer
 * @returns {object | undefined}
 */
function kCertificateOf(result, writer) {
    return result.records.find(
        (record) =>
            record.kind === "validate" &&
            nodeKeyToCanonicalString(record.node) === nodeKeyOf(NODE_K) &&
            journalAuthorToString(record.id.author) === writer
    );
}

describe("a locally authored joining occurrence records the legacy validity edge it held", () => {
    test("a joining K with no legacy D -> K edge records unknown for its current input", async () => {
        const joiningState = sourceOf(persistedState([
            persistedNode(1, { modifiedAt: EARLY }),
            persistedNode(2, {
                modifiedAt: LATE,
                payload: { type: "entry_description", description: "joining different value" },
                validInputs: [],
                upToDate: false,
            }),
        ]));
        const result = await join(joiningState, JOINER);

        const certificate = kCertificateOf(result, JOINER);
        expect(certificate).toBeDefined();
        const basis = certificate.basis.find(
            (entry) => nodeKeyToCanonicalString(entry.input) === nodeKeyOf(NODE_D)
        );
        expect(basis).toBeDefined();
        expect(basis.value).toBe("unknown");

        const selected = result.projection.occurrences.find(
            (occurrence) => occurrence.nodeKeyString === nodeKeyOf(NODE_K)
        );
        expect(selected).toBeDefined();
        expect(selected.validInputs.has(nodeKeyOf(NODE_D))).toBe(false);
    });

    test("a joining K with the legacy D -> K edge still names the input occurrence", async () => {
        const joiningState = sourceOf(persistedState([
            persistedNode(1, { modifiedAt: EARLY }),
            persistedNode(2, {
                modifiedAt: LATE,
                payload: { type: "entry_description", description: "joining different value" },
                validInputs: [nodeKeyOf(NODE_D)],
                upToDate: false,
            }),
        ]));
        const result = await join(joiningState, JOINER);

        const certificate = kCertificateOf(result, JOINER);
        expect(certificate).toBeDefined();
        const basis = certificate.basis.find(
            (entry) => nodeKeyToCanonicalString(entry.input) === nodeKeyOf(NODE_D)
        );
        expect(basis).toBeDefined();
        expect(basis.value).not.toBe("unknown");
        expect(journalRecordIdToString(basis.value)).toBe("aaaaaaaaa:1");
    });
});
