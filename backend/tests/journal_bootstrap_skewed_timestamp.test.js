/**
 * `incremental-graph-journal-testing.md` §Bootstrap skewed timestamp preservation.
 *
 * The claim is about immutable occurrence fields crossing the pre-Journal boundary. A
 * supported persisted legacy replica may hold a materialization whose `createdAt` is
 * *after* its `modifiedAt`, and a bootstrap which authors that occurrence must transport
 * both persisted timestamps exactly: no path may reject, reorder, clamp or synthesize them
 * merely to impose chronological ordering between the two fields.
 *
 * Canonical bootstrap (pass C1): the skewed occurrence is staged with both legacy
 * timestamps preserved in the bootstrap `ValueEvent`, and the artifact replays to them.
 *
 * Joining bootstrap (pass J1): a joining legacy occurrence with skewed timestamps which
 * differs from the canonical occurrence becomes a historical joining `ValueEvent` that
 * preserves both joining timestamps exactly.
 */

const {
    canonicalArtifactReplica,
    isJoinedCanonicalBootstrap,
    joinCanonicalBootstrap,
    makeCanonicalBootstrapSnapshot,
    readLegacyBootstrapState,
    stageCanonicalBootstrap,
} = require("../src/generators/incremental_graph/journal/bootstrap");

const {
    journalAuthorToString,
    makeJournalAuthor,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const {
    makeReplicaSource,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal/oracle");

const CREATOR = "aaaaaaaaa";
const JOINER = "bbbbbbbbb";
const GRAPH_SCHEME = "incremental-graph-default";
const CREATED_AT = "2020-01-01T00:00:00.000Z";
const EARLY = "2020-01-02T00:00:00.000Z";
const LATE = "2020-03-04T00:00:00.000Z";
const TARGET_VERSION = "3";

/** The skewed pair: the creation instant is after the modification instant. */
const SKEWED_CREATED = "2020-06-06T00:00:00.000Z";
const SKEWED_MODIFIED = "2020-01-01T00:00:00.000Z";
/** A second skewed pair whose modification instant succeeds the canonical occurrence's. */
const SKEWED_WINNING_CREATED = "2021-08-08T00:00:00.000Z";
const SKEWED_WINNING_MODIFIED = "2020-05-05T00:00:00.000Z";

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
function stagedOf(legacyState, creator) {
    const candidate = stageCanonicalBootstrap({
        legacyState,
        creatorWriter: makeJournalAuthor(creator),
        targetVersion: TARGET_VERSION,
    });
    if (candidate instanceof Error) {
        throw candidate;
    }
    return candidate;
}

/**
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
 * The current graph schema implied by a set of legacy graphs: a node's direct inputs
 * are the union of the direct legacy inputs either replica persisted for it.
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

describe("canonical bootstrap passes a skewed legacy occurrence through unchanged", () => {
    test("the skewed state is a supported source", () => {
        const legacyState = sourceOf(
            persistedState([
                persistedNode(1, {
                    createdAt: SKEWED_CREATED,
                    modifiedAt: SKEWED_MODIFIED,
                    upToDate: false,
                }),
                persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
            ])
        );
        expect(SKEWED_CREATED > SKEWED_MODIFIED).toBe(true);
        const skewed = legacyState.nodeAt(nodeKeyOf(1));
        expect(skewed.createdAt).toBe(SKEWED_CREATED);
        expect(skewed.modifiedAt).toBe(SKEWED_MODIFIED);
    });

    test("C1 preserves both legacy timestamps of the skewed occurrence", () => {
        const legacyState = sourceOf(
            persistedState([
                persistedNode(1, {
                    createdAt: SKEWED_CREATED,
                    modifiedAt: SKEWED_MODIFIED,
                    upToDate: false,
                }),
                persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
            ])
        );
        const candidate = stagedOf(legacyState, CREATOR);
        const values = candidate.records.filter((record) => record.kind === "value");
        // C1 allocates by nondecreasing `(modifiedAt, canonical NodeKey)`, and the
        // skewed occurrence carries the earliest modified instant, so it is authored
        // first with its own two persisted timestamps.
        expect(values.map((record) => record.node.args[0].id)).toEqual([1, 2]);
        expect(values[0].createdAt).toBe(SKEWED_CREATED);
        expect(values[0].modifiedAt).toBe(SKEWED_MODIFIED);
        expect(values[0].nodeIdentifier).toBe(identifierOf(1));
        expect(values[1].createdAt).toBe(CREATED_AT);
        expect(values[1].modifiedAt).toBe(LATE);
    });

    test("the artifact replays to the skewed occurrence with both timestamps", () => {
        const legacyState = sourceOf(
            persistedState([
                persistedNode(1, {
                    createdAt: SKEWED_CREATED,
                    modifiedAt: SKEWED_MODIFIED,
                    upToDate: false,
                }),
                persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
            ])
        );
        const candidate = stagedOf(legacyState, CREATOR);
        const projection = projectRetainedJournal({
            source: makeReplicaSource(canonicalArtifactReplica(artifactOf(candidate))),
            localWriter: candidate.creatorWriter,
            currentInputKeysOfNode: (nodeKeyString) => {
                const node = legacyState.nodeAt(nodeKeyString);
                return node === undefined
                    ? undefined
                    : node.directInputKeys.map(nodeKeyToCanonicalString);
            },
        });
        if (projection instanceof Error) {
            throw projection;
        }
        const values = new Map(
            projection.occurrences.map((occurrence) => [occurrence.nodeKeyString, occurrence])
        );
        expect(values.get(nodeKeyOf(1)).createdAt).toBe(SKEWED_CREATED);
        expect(values.get(nodeKeyOf(1)).modifiedAt).toBe(SKEWED_MODIFIED);
        expect(values.get(nodeKeyOf(2)).createdAt).toBe(CREATED_AT);
        expect(values.get(nodeKeyOf(2)).modifiedAt).toBe(LATE);
    });
});

describe("joining bootstrap passes a skewed joining occurrence through unchanged", () => {
    test("J1 preserves both timestamps of a skewed joining occurrence, whichever occurrence wins", async () => {
        const canonicalState = sourceOf(
            persistedState([
                persistedNode(1, { upToDate: false }),
                persistedNode(2, { modifiedAt: LATE, validInputs: [nodeKeyOf(1)] }),
            ])
        );
        const artifact = artifactOf(stagedOf(canonicalState, CREATOR));

        // A skewed joining occurrence whose modification instant precedes the canonical
        // one: it loses ordinary conflict authority, so J1 still authors it as a
        // historical joining value and the projection keeps selecting the canonical
        // occurrence beside it.
        const losing = sourceOf(
            persistedState(
                [
                    persistedNode(1, { upToDate: false }),
                    persistedNode(2, {
                        createdAt: SKEWED_CREATED,
                        modifiedAt: SKEWED_MODIFIED,
                        validInputs: [nodeKeyOf(1)],
                        payload: payloadOf(2, "the earlier skewed joining occurrence"),
                    }),
                ],
                9
            )
        );
        const losingJoin = joinCanonicalBootstrap({
            legacyState: losing,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schemaOf([losing]),
        });
        expect(isJoinedCanonicalBootstrap(losingJoin)).toBe(true);
        if (losingJoin instanceof Error) {
            return;
        }
        const losingHistorical = losingJoin.records.filter(
            (record) =>
                record.kind === "value" &&
                journalAuthorToString(record.id.author) === JOINER &&
                nodeKeyToCanonicalString(record.node) === nodeKeyOf(2)
        );
        expect(losingHistorical).toHaveLength(1);
        expect(losingHistorical[0].reason).toBe("bootstrap");
        expect(losingHistorical[0].createdAt).toBe(SKEWED_CREATED);
        expect(losingHistorical[0].modifiedAt).toBe(SKEWED_MODIFIED);
        expect(losingHistorical[0].nodeIdentifier).toBe(identifierOf(2));
        const losingSelected = losingJoin.projection.occurrences.find(
            (occurrence) => occurrence.nodeKeyString === nodeKeyOf(2)
        );
        expect(journalAuthorToString(losingSelected.valueId.author)).toBe(CREATOR);
        expect(losingSelected.modifiedAt).toBe(LATE);

        // A skewed joining occurrence whose modification instant succeeds the canonical
        // one while its creation instant succeeds them both: it wins conflict authority,
        // and the observable projection carries the skewed pair exactly.
        const winning = sourceOf(
            persistedState(
                [
                    persistedNode(1, { upToDate: false }),
                    persistedNode(2, {
                        createdAt: SKEWED_WINNING_CREATED,
                        modifiedAt: SKEWED_WINNING_MODIFIED,
                        validInputs: [nodeKeyOf(1)],
                        payload: payloadOf(2, "the later skewed joining occurrence"),
                    }),
                ],
                9
            )
        );
        const winningJoin = joinCanonicalBootstrap({
            legacyState: winning,
            artifact,
            joiningWriter: makeJournalAuthor(JOINER),
            currentInputKeysOfNode: schemaOf([winning]),
        });
        expect(isJoinedCanonicalBootstrap(winningJoin)).toBe(true);
        if (winningJoin instanceof Error) {
            return;
        }
        const winningHistorical = winningJoin.records.filter(
            (record) =>
                record.kind === "value" &&
                journalAuthorToString(record.id.author) === JOINER &&
                nodeKeyToCanonicalString(record.node) === nodeKeyOf(2)
        );
        expect(winningHistorical).toHaveLength(1);
        expect(winningHistorical[0].createdAt).toBe(SKEWED_WINNING_CREATED);
        expect(winningHistorical[0].modifiedAt).toBe(SKEWED_WINNING_MODIFIED);

        const winningSelected = winningJoin.projection.occurrences.find(
            (occurrence) => occurrence.nodeKeyString === nodeKeyOf(2)
        );
        expect(journalAuthorToString(winningSelected.valueId.author)).toBe(JOINER);
        expect(winningSelected.createdAt).toBe(SKEWED_WINNING_CREATED);
        expect(winningSelected.modifiedAt).toBe(SKEWED_WINNING_MODIFIED);
    });
});
