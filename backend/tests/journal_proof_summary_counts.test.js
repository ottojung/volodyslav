/**
 * The counted eligible-proof summary's `2 -> 1 -> 0` progression for one edge,
 * driven through ordinary publication and through a staged synchronization cutover.
 *
 * `incremental-graph-journal-testing.md` §Counted eligible-proof summary tests
 * requires, for one current occurrence `V` of `K` and input `D`:
 *
 * ```text
 * retain two independently eligible/effective certificates which both prove D
 *     => eligibleProofEdgeCount(K, V, D) == 2
 * apply a change which makes exactly one certificate ineligible, or its D entry
 * ineffective
 *     => count 1, and D stays in eligibleEffectiveProofUnion(K)
 * apply a change which removes the second contribution
 *     => count 0, and D is absent from the union
 * ```
 *
 * and requires those transitions to be run through ordinary publication and
 * through staged synchronization/reset cutover, with the counts read from the
 * maintained summary rather than recomputed by scanning retained certificate
 * history. The reset path already reads counts directly; these tests are the
 * publication and synchronization halves.
 *
 * The edge here is `D -> B`, `B`'s single current input is `D`, and `B`'s one
 * selected occurrence is proved by two certificates. A node-scoped invalidation
 * makes a certificate ineligible exactly when the certificate's context does not
 * causally cover the invalidation, so the progression is driven by invalidations
 * that a replacement certificate re-covers: the summary's count falls while the
 * replacement keeps the edge present, then falls to zero when the replacement is
 * itself retired.
 */

const {
    journalAuthorToString,
    makeAuthorityTime,
    makeInvalidateEvent,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeNodeScope,
    makeReplicaSource,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const { withCollectedRecords } = require("./journal_record_growth_helper");

const {
    SnapshotIdentityClass,
    synchronizeRetainedJournal,
} = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
    countEligibleProofEdges,
    eligibleProofEdgeUnion,
    isRetainedReplayState,
} = require("../src/generators/incremental_graph/journal_retained");

const {
    appendRetainedStateOp,
    maintainedRetainedState,
} = require("../src/generators/incremental_graph/journal_store");

const NODE_B = { head: "event", args: [{ id: 2 }] };
const NODE_D = { head: "event", args: [{ id: 4 }] };
const KEY_B = nodeKeyToCanonicalString(NODE_B);
const KEY_D = nodeKeyToCanonicalString(NODE_D);
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const LOCAL_AUTHOR = makeJournalAuthor(WRITER_LOCAL);
const PEER_AUTHOR = makeJournalAuthor(WRITER_PEER);
const PAYLOAD = { type: "entry_description", description: "x" };
const INSTANT = 1700000000000;

/**
 * `B` depends on the single input `D`; `D` is a leaf. A single input makes the
 * count of one edge unambiguous.
 *
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function oneInputSchema(nodeKeyString) {
    return nodeKeyString === KEY_B ? [KEY_D] : [];
}

/**
 * @param {ReadonlyArray<string>} coordinates
 * @returns {import("../src/generators/incremental_graph/journal").JournalFrontier}
 */
function contextOf(coordinates) {
    return makeJournalFrontierFromText(coordinates);
}

/**
 * The coordinates a writer's record at `sequence` observed: what the caller said
 * it had seen, plus the writer's own immediate already-committed predecessor.
 *
 * @param {string} writer
 * @param {string} sequence
 * @param {ReadonlyArray<string>} observed
 * @returns {ReadonlyArray<string>}
 */
function observedUpTo(writer, sequence, observed) {
    const previous = Number(sequence) - 1;
    if (previous === 0) {
        return [...observed];
    }
    return [...observed, [writer, String(previous)]];
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
 * @param {number} physical
 * @returns {import("../src/generators/incremental_graph/journal").AuthorityTime}
 */
function authorityOf(physical) {
    return made(makeAuthorityTime(physical, "0"));
}

/**
 * @param {string} nodeKeyString
 * @returns {string}
 */
function identifierOf(nodeKeyString) {
    return JSON.parse(nodeKeyString).args[0].id + "-abcdefghi";
}

/**
 * One materialization, as the writer which produced it retained it.
 *
 * @param {object} occurrence
 * @param {string} occurrence.writer
 * @param {string} occurrence.sequence
 * @param {import("../src/generators/incremental_graph/journal").NodeKey} occurrence.node
 * @param {ReadonlyArray<string>} occurrence.context
 * @param {number} occurrence.authority
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
 */
function materialize(occurrence) {
    return made(makeValueEvent(
        {
            id: occurrence.writer + ":" + occurrence.sequence,
            context: contextOf(observedUpTo(occurrence.writer, occurrence.sequence, occurrence.context)),
            authorityTime: authorityOf(occurrence.authority),
            node: occurrence.node,
        },
        identifierOf(nodeKeyToCanonicalString(occurrence.node)),
        PAYLOAD,
        NOW,
        LATER,
        "compute"
    ));
}

/**
 * One validation against the exact current inputs of its node.
 *
 * @param {object} validation
 * @param {string} validation.writer
 * @param {string} validation.sequence
 * @param {import("../src/generators/incremental_graph/journal").NodeKey} validation.node
 * @param {ReadonlyArray<string>} validation.context
 * @param {number} validation.authority
 * @param {string} validation.value
 * @param {ReadonlyArray<{node: import("../src/generators/incremental_graph/journal").NodeKey, value: string}>} validation.basis
 * @param {string} [validation.reason]
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
 */
function validate(validation) {
    return made(makeValidateEvent(
        {
            id: validation.writer + ":" + validation.sequence,
            context: contextOf(observedUpTo(validation.writer, validation.sequence, validation.context)),
            authorityTime: authorityOf(validation.authority),
            node: validation.node,
        },
        validation.value,
        validation.basis.map((entry) => makeValidationBasisEntry(entry.node, entry.value)),
        validation.reason === undefined ? "compute" : validation.reason
    ));
}

/**
 * One node-scoped invalidation of its node.
 *
 * @param {object} invalidation
 * @param {string} invalidation.writer
 * @param {string} invalidation.sequence
 * @param {import("../src/generators/incremental_graph/journal").NodeKey} invalidation.node
 * @param {ReadonlyArray<string>} invalidation.context
 * @param {number} invalidation.authority
 * @param {string} [invalidation.reason]
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
 */
function invalidateNode(invalidation) {
    return made(makeInvalidateEvent(
        {
            id: invalidation.writer + ":" + invalidation.sequence,
            context: contextOf(observedUpTo(invalidation.writer, invalidation.sequence, invalidation.context)),
            authorityTime: authorityOf(invalidation.authority),
            node: invalidation.node,
        },
        makeNodeScope(),
        invalidation.reason === undefined ? "propagated" : invalidation.reason
    ));
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {import("../src/generators/incremental_graph/journal").JournalReplica}
 */
function replicaOf(records) {
    /** @type {Map<string, import("../src/generators/incremental_graph/journal").JournalRecord[]>} */
    const byWriter = new Map();
    for (const record of records) {
        const name = journalAuthorToString(record.id.author);
        const stream = byWriter.get(name) ?? [];
        stream.push(record);
        byWriter.set(name, stream);
    }
    return makeJournalReplica([...byWriter.entries()]);
}

/**
 * The receiver's supported base pair: `D` is proved from nothing, `B` is
 * materialized as occurrence `WRITER_LOCAL:3`, and two certificates of that one
 * occurrence both prove `D`, so the counted edge `D -> B` is two.
 *
 * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
 */
function baseWithTwoProvingCertificates() {
    return [
        materialize({ writer: WRITER_LOCAL, sequence: "1", node: NODE_D, context: [], authority: 100 }),
        validate({
            writer: WRITER_LOCAL,
            sequence: "2",
            node: NODE_D,
            context: [],
            authority: 101,
            value: WRITER_LOCAL + ":1",
            basis: [],
        }),
        materialize({ writer: WRITER_LOCAL, sequence: "3", node: NODE_B, context: [], authority: 102 }),
        validate({
            writer: WRITER_LOCAL,
            sequence: "4",
            node: NODE_B,
            context: [],
            authority: 103,
            value: WRITER_LOCAL + ":3",
            basis: [{ node: NODE_D, value: WRITER_LOCAL + ":1" }],
        }),
        validate({
            writer: WRITER_LOCAL,
            sequence: "5",
            node: NODE_B,
            context: [],
            authority: 104,
            value: WRITER_LOCAL + ":3",
            basis: [{ node: NODE_D, value: WRITER_LOCAL + ":1" }],
        }),
    ];
}

/**
 * A receiver's retained replay state, built by the maintenance traversal from
 * `records`. This is the state the operation under test must extend.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {Promise<import("../src/generators/incremental_graph/journal_retained").RetainedReplayState>}
 */
async function builtStateOf(records) {
    const built = await buildRetainedReplayState({
        source: makeReplicaSource(replicaOf(records)),
        localWriter: LOCAL_AUTHOR,
        currentInputKeysOfNode: oneInputSchema,
    });
    if ("error" in built) {
        throw new Error("the fixture state could not be built: " + built.error.message);
    }
    return built.state;
}

/**
 * The count of the `D -> B` edge in a summary, read from the counted index.
 *
 * @param {import("../src/generators/incremental_graph/journal_retained").ProofSummary} summary
 * @param {string} valueId
 * @returns {number}
 */
function countOfD(summary, valueId) {
    return countEligibleProofEdges({
        summary,
        nodeKeyString: KEY_B,
        valueId,
        inputKeyString: KEY_D,
        authorOf: (name) => (name === WRITER_LOCAL ? LOCAL_AUTHOR : PEER_AUTHOR),
    });
}

/**
 * The count the explicit rebuild of a whole journal reproduces, which the
 * specification permits as an oracle and requires to agree with the maintained
 * summary.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @param {string} valueId
 * @returns {Promise<number>}
 */
async function rebuiltCountOf(records, valueId) {
    return countOfD((await builtStateOf(records)).proofs, valueId);
}

/**
 * @param {import("../src/generators/incremental_graph/journal_retained").ProofSummary} summary
 * @param {string} valueId
 * @returns {ReadonlyArray<string>}
 */
function unionOfB(summary, valueId) {
    return [...eligibleProofEdgeUnion({
        summary,
        nodeKeyString: KEY_B,
        valueId,
        authorOf: (name) => (name === WRITER_LOCAL ? LOCAL_AUTHOR : PEER_AUTHOR),
    })].sort();
}

/**
 * A fake Journal sublevel which stores the summary key, so an ordinary
 * publication's maintenance can read what the previous publication persisted.
 *
 * @returns {object}
 */
function fakeJournal() {
    /** @type {Map<string, unknown>} */
    const stored = new Map();
    return {
        async get(key) {
            return stored.get(String(key));
        },
        putOp(key, value) {
            return { type: "put", key, value, __fake: true, commit: () => stored.set(String(key), value) };
        },
        async *keys() {
            for (const key of stored.keys()) {
                yield key;
            }
        },
    };
}

/**
 * Persist one retained replay state into the fake Journal sublevel.
 *
 * @param {object} journal
 * @param {import("../src/generators/incremental_graph/journal_retained").RetainedReplayState} state
 */
function persist(journal, state) {
    const operations = [];
    const rejected = appendRetainedStateOp(journal, operations, state);
    if (rejected !== undefined) {
        throw rejected;
    }
    for (const operation of operations) {
        operation.commit();
    }
}

describe("an ordinary publication maintains the counted eligible-proof summary", () => {
    test("the D -> B count falls 2 -> 1 -> 0 and the union tracks it", async () => {
        const base = baseWithTwoProvingCertificates();
        const journal = fakeJournal();
        persist(journal, await builtStateOf(base));

        // The base retains two independently eligible and effective certificates
        // which both prove D, so the count is two and D is in the union. The
        // explicit rebuild of the same journal reproduces the count.
        const start = await maintainedRetainedState(journal, WRITER_LOCAL, oneInputSchema, []);
        expect(countOfD(start.proofs, WRITER_LOCAL + ":3")).toBe(2);
        expect(unionOfB(start.proofs, WRITER_LOCAL + ":3")).toEqual([KEY_D]);
        expect(await rebuiltCountOf(base, WRITER_LOCAL + ":3")).toBe(2);

        // A publication which invalidates the node and revalidates the same
        // occurrence: the replacement certificate observes the invalidation, the two
        // original certificates do not, so exactly one contribution remains.
        const retiredOnce = [
            invalidateNode({ writer: WRITER_LOCAL, sequence: "6", node: NODE_B, context: [], authority: 105 }),
            validate({
                writer: WRITER_LOCAL,
                sequence: "7",
                node: NODE_B,
                context: [],
                authority: 106,
                value: WRITER_LOCAL + ":3",
                basis: [{ node: NODE_D, value: WRITER_LOCAL + ":1" }],
                reason: "cache-revalidate",
            }),
        ];
        const afterOne = await maintainedRetainedState(journal, WRITER_LOCAL, oneInputSchema, retiredOnce);
        expect(countOfD(afterOne.proofs, WRITER_LOCAL + ":3")).toBe(1);
        expect(unionOfB(afterOne.proofs, WRITER_LOCAL + ":3")).toEqual([KEY_D]);
        expect(await rebuiltCountOf([...base, ...retiredOnce], WRITER_LOCAL + ":3")).toBe(1);
        persist(journal, afterOne);

        // A second publication invalidates the node again with no replacement, so
        // the remaining contribution is removed: count zero and D leaves the union.
        const retiredTwice = [
            invalidateNode({ writer: WRITER_LOCAL, sequence: "8", node: NODE_B, context: [], authority: 107 }),
        ];
        const afterTwo = await maintainedRetainedState(journal, WRITER_LOCAL, oneInputSchema, retiredTwice);
        expect(countOfD(afterTwo.proofs, WRITER_LOCAL + ":3")).toBe(0);
        expect(unionOfB(afterTwo.proofs, WRITER_LOCAL + ":3")).toEqual([]);
        expect(await rebuiltCountOf([...base, ...retiredOnce, ...retiredTwice], WRITER_LOCAL + ":3")).toBe(0);
    });
});

describe("a staged synchronization cutover maintains the counted eligible-proof summary", () => {
    test("the D -> B count falls 2 -> 1 -> 0 and the union tracks it", async () => {
        const base = baseWithTwoProvingCertificates();
        const identity = new SnapshotIdentityClass("v1", "scheme");
        const baseState = await builtStateOf(base);

        const sync = async (receiver, source, retainedState) => {
            const own = receiver.filter((record) => journalAuthorToString(record.id.author) === WRITER_LOCAL);
            const last = own[own.length - 1];
            const result = await synchronizeRetainedJournal({
                receiver: makeReplicaSource(replicaOf(receiver)),
                source: makeReplicaSource(replicaOf(source)),
                localWriter: LOCAL_AUTHOR,
                committed: {
                    localWriter: LOCAL_AUTHOR,
                    writerHead: last.id.sequence,
                    committedFrontier: contextOf([[WRITER_LOCAL, String(Number(last.id.sequence))]]),
                    authorityHighWater: authorityOf(700),
                    allocatorWatermark: 0,
                },
                observedHighWater: authorityOf(700),
                publicationInstant: INSTANT,
                currentInputKeysOfNode: oneInputSchema,
                receiverIdentity: identity,
                sourceIdentity: identity,
                retainedState,
            });
            if (!("outcome" in result)) {
                throw new Error("synchronization failed with " + result.error.name + ": " + result.error.message);
            }
            expect(isRetainedReplayState(result.outcome.retainedState)).toBe(true);
            await withCollectedRecords(result);
            return result.outcome;
        };

        // A peer source which invalidates `B` and revalidates the same occurrence
        // after observing its own invalidation. Importing the peer suffix retires the
        // receiver's two certificates and leaves the peer's one, so exactly one
        // contribution remains.
        const peerOne = [
            invalidateNode({ writer: WRITER_PEER, sequence: "1", node: NODE_B, context: [[WRITER_LOCAL, "5"]], authority: 200, reason: "explicit" }),
            validate({
                writer: WRITER_PEER,
                sequence: "2",
                node: NODE_B,
                context: [[WRITER_LOCAL, "5"]],
                authority: 201,
                value: WRITER_LOCAL + ":3",
                basis: [{ node: NODE_D, value: WRITER_LOCAL + ":1" }],
            }),
        ];
        const outcomeOne = await sync(base, peerOne, baseState);
        expect(countOfD(outcomeOne.retainedState.proofs, WRITER_LOCAL + ":3")).toBe(1);
        expect(unionOfB(outcomeOne.retainedState.proofs, WRITER_LOCAL + ":3")).toEqual([KEY_D]);
        expect(await rebuiltCountOf([...base, ...outcomeOne.records], WRITER_LOCAL + ":3")).toBe(1);

        // The peer then invalidates `B` again with no replacement, so the remaining
        // contribution is removed: count zero and D leaves the union.
        const peerTwo = [
            ...peerOne,
            invalidateNode({ writer: WRITER_PEER, sequence: "3", node: NODE_B, context: [[WRITER_LOCAL, "5"]], authority: 202, reason: "explicit" }),
        ];
        const outcomeTwo = await sync(
            [...base, ...outcomeOne.records],
            peerTwo,
            outcomeOne.retainedState
        );
        expect(countOfD(outcomeTwo.retainedState.proofs, WRITER_LOCAL + ":3")).toBe(0);
        expect(unionOfB(outcomeTwo.retainedState.proofs, WRITER_LOCAL + ":3")).toEqual([]);
        expect(await rebuiltCountOf(
            [...base, ...outcomeOne.records, ...outcomeTwo.records],
            WRITER_LOCAL + ":3"
        )).toBe(0);
    });
});
