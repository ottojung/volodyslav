"use strict";

/**
 * `incremental-graph-journal-testing.md` §Frozen-cut rollback regression.
 *
 * The scenario:
 *
 * ```text
 * bootstrap artifact: K=v1
 * creator later: K=v2; create N
 * late legacy: K=v1; N absent
 * ```
 *
 * A late-joining legacy host holds only the frozen canonical cut (K=v1, N absent).
 * The join must see only that cut: it reuses K=v1 identity, authors no delete for N
 * (legacy cache absence is not timestamped deletion evidence), and cannot turn the
 * stale v1 into the newer v2 at upgrade time. Later ordinary compatible sync imports
 * v2/N from the creator.
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

function nodeOf(id) {
    return { head: "entry_description", args: [{ id }] };
}

function nodeKeyOf(id) {
    return nodeKeyToCanonicalString(nodeOf(id));
}

function identifierOf(id) {
    return String(id) + "-abcdefghi";
}

function payloadOf(id, description) {
    return {
        type: "entry_description",
        description: description ?? "entry " + String(id),
    };
}

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

function persistedState(nodes, lastNodeIndex) {
    return { graphSchemeString: GRAPH_SCHEME, lastNodeIndex: lastNodeIndex ?? 7, nodes };
}

function sourceOf(state) {
    const validated = readLegacyBootstrapState(state);
    if (validated instanceof Error) {
        throw validated;
    }
    return validated;
}

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

function schemaOf(states) {
    return (nodeKeyString) => {
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
 * The frozen canonical cut: node 1 (N) and node 2 (K) are both materialized, with
 * K depending on N. This is the bootstrap artifact the cohort holds.
 */
function canonicalCut() {
    const legacyState = sourceOf(
        persistedState([
            persistedNode(1, { modifiedAt: EARLY, upToDate: false }),
            persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
        ])
    );
    const { artifact } = artifactFrom(legacyState, CREATOR);
    return { artifact, legacyState };
}

describe("frozen-cut rollback regression", () => {
    test("a late join of the frozen cut reuses K=v1 and authors no delete for N", async () => {
        const { artifact } = canonicalCut();
        const joining = sourceOf(
            persistedState([
                persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
            ])
        );
        const schema = schemaOf([joining]);
        const joined = await joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schema,
        });
        if (joined instanceof Error) {
            throw joined;
        }
        expect(isJoinedCanonicalBootstrap(joined)).toBe(true);

        const canonicalK = artifact.records.find(
            (record) =>
                record.kind === "value" && nodeKeyToCanonicalString(record.node) === nodeKeyOf(2)
        );
        expect(canonicalK).toBeDefined();

        const selected = occurrenceOf(joined.projection, 2);
        expect(journalRecordIdToString(selected.valueId)).toBe(
            journalRecordIdToString(canonicalK.id)
        );
        expect(
            joined.records.some(
                (record) =>
                    record.kind === "value" &&
                    journalAuthorToString(record.id.author) === JOINER &&
                    nodeKeyToCanonicalString(record.node) === nodeKeyOf(2)
            )
        ).toBe(false);

        expect(
            joined.records.some(
                (record) =>
                    record.kind === "delete" ||
                    (record.kind === "invalidate" &&
                        journalAuthorToString(record.id.author) === JOINER &&
                        nodeKeyToCanonicalString(record.node) === nodeKeyOf(1))
            )
        ).toBe(false);

        expect(
            joined.projection.occurrences.some(
                (occurrence) => occurrence.nodeKeyString === nodeKeyOf(1)
            )
        ).toBe(true);
    });

    test("upgrade time cannot turn stale v1 into newer write; later sync imports v2/N", async () => {
        const { artifact, legacyState } = canonicalCut();
        const joining = sourceOf(
            persistedState([
                persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
            ])
        );
        const schema = schemaOf([joining, legacyState]);
        const joined = await joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schema,
        });
        if (joined instanceof Error) {
            throw joined;
        }
        expect(isJoinedCanonicalBootstrap(joined)).toBe(true);

        const selectedAfterJoin = occurrenceOf(joined.projection, 2);
        const canonicalK = artifact.records.find(
            (record) =>
                record.kind === "value" && nodeKeyToCanonicalString(record.node) === nodeKeyOf(2)
        );
        expect(journalRecordIdToString(selectedAfterJoin.valueId)).toBe(
            journalRecordIdToString(canonicalK.id)
        );

        const creatorN = artifact.records.find(
            (record) =>
                record.kind === "value" && nodeKeyToCanonicalString(record.node) === nodeKeyOf(1)
        );
        expect(creatorN).toBeDefined();

        expect(
            joined.projection.occurrences.some(
                (occurrence) => occurrence.nodeKeyString === nodeKeyOf(1)
            )
        ).toBe(true);
        expect(
            joined.projection.occurrences.some(
                (occurrence) => occurrence.nodeKeyString === nodeKeyOf(2)
            )
        ).toBe(true);

        expect(joined.records.some((record) => record.kind === "delete")).toBe(false);
    });

    test("the joining writer authors no value for K and no delete for N", async () => {
        const { artifact } = canonicalCut();
        const joining = sourceOf(
            persistedState([
                persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
            ])
        );
        const schema = schemaOf([joining]);
        const joined = await joinCanonicalBootstrap({
            legacyState: joining,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schema,
        });
        if (joined instanceof Error) {
            throw joined;
        }
        expect(isJoinedCanonicalBootstrap(joined)).toBe(true);

        const joiningValues = joined.records.filter(
            (record) =>
                record.kind === "value" && journalAuthorToString(record.id.author) === JOINER
        );
        expect(joiningValues).toEqual([]);

        expect(joined.records.some((record) => record.kind === "delete")).toBe(false);

        expect(
            joined.projection.occurrences.some(
                (occurrence) => occurrence.nodeKeyString === nodeKeyOf(1)
            )
        ).toBe(true);
        expect(
            joined.projection.occurrences.some(
                (occurrence) => occurrence.nodeKeyString === nodeKeyOf(2)
            )
        ).toBe(true);
    });
});
