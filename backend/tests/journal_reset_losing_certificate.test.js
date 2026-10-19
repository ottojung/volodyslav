/**
 * Reset's losing-certificate proof exposure regression.
 *
 * `incremental-graph-journal-testing.md` §Reset losing-certificate proof exposure
 * regression requires, for one preserved occurrence `V` of `K` with current inputs
 * `A1`/`B1` and two eligible certificates:
 *
 * ```text
 * C1 higher authority: {A:A1, B:B0} -> effective {A}
 * C2 lower authority:  {A:A0, B:B1} -> effective {B}
 * target validity: {}
 * ```
 *
 * `C1` wins selection, so the certificate reset happens to commit names only the
 * `A` edge. Reset MUST compute `eligibleEffectiveProofUnion_P1(K) = {A, B}` across
 * every eligible certificate, author `proof(V,A)` and `proof(V,B)` barriers, and
 * finish with zero incoming validity. It MUST NOT barrier only `A` and let the
 * losing `C2` expose `B`. Positive replay proof still comes from one certificate;
 * the union is used only for negative barrier selection.
 *
 * The fixture below gives `A` and `B` two occurrences each so the current selected
 * occurrence of each is unambiguous, and two certificates of `K1` whose bases each
 * name one current and one stale input. The higher-authority `C1` proves only `A`;
 * the lower-authority `C2` proves only `B`.
 */

const {
    journalAuthorToString,
    journalRecordIdToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeJournalSequence,
    makeReplicaSource,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    nodeKeyToCanonicalString,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal");

const { SnapshotIdentityClass } = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
    makeResetSource,
    resetToSource,
} = require("../src/generators/incremental_graph/journal_reset");

const NODE_A = { head: "event", args: [{ id: 1 }] };
const NODE_B = { head: "event", args: [{ id: 2 }] };
const NODE_K = { head: "event", args: [{ id: 3 }] };
const KEY_A = nodeKeyToCanonicalString(NODE_A);
const KEY_B = nodeKeyToCanonicalString(NODE_B);
const KEY_K = nodeKeyToCanonicalString(NODE_K);
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const LOCAL_AUTHOR = makeJournalAuthor(WRITER_LOCAL);
const PEER_AUTHOR = makeJournalAuthor(WRITER_PEER);
const PAYLOAD = { type: "entry_description", description: "x" };
const INSTANT = 1700000000000;

/**
 * `K` depends on the two leaves `A` and `B`.
 *
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function kSchema(nodeKeyString) {
    if (nodeKeyString === KEY_K) {
        return [KEY_A, KEY_B];
    }
    return [];
}

/**
 * @param {ReadonlyArray<string>} coordinates
 * @returns {import("../src/generators/incremental_graph/journal").JournalFrontier}
 */
function contextOf(coordinates) {
    return makeJournalFrontierFromText(coordinates);
}

/**
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
    return makeAuthorityTime(physical, "0");
}

/**
 * @param {string} nodeKeyString
 * @returns {string}
 */
function identifierOf(nodeKeyString) {
    return JSON.parse(nodeKeyString).args[0].id + "-abcdefghi";
}

/**
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
 * @param {object} validation
 * @param {string} validation.writer
 * @param {string} validation.sequence
 * @param {import("../src/generators/incremental_graph/journal").NodeKey} validation.node
 * @param {ReadonlyArray<string>} validation.context
 * @param {number} validation.authority
 * @param {string} validation.value
 * @param {ReadonlyArray<{node: import("../src/generators/incremental_graph/journal").NodeKey, value: string}>} validation.basis
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
        "compute"
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
    return made(makeJournalReplica([...byWriter.entries()]));
}

/**
 * The receiver's two eligible certificates of `K1`: the higher-authority `C1`
 * proves only `A` (its `B` basis names the stale `B0`), and the lower-authority
 * `C2` proves only `B` (its `A` basis names the stale `A0`).
 *
 * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
 */
function receiverWithTwoCertificates() {
    return [
        materialize({ writer: WRITER_LOCAL, sequence: "1", node: NODE_A, context: [], authority: 10 }),
        materialize({ writer: WRITER_LOCAL, sequence: "2", node: NODE_B, context: [], authority: 12 }),
        materialize({ writer: WRITER_LOCAL, sequence: "3", node: NODE_A, context: [], authority: 20 }),
        materialize({ writer: WRITER_LOCAL, sequence: "4", node: NODE_B, context: [], authority: 22 }),
        materialize({ writer: WRITER_LOCAL, sequence: "5", node: NODE_K, context: [], authority: 30 }),
        validate({
            writer: WRITER_LOCAL,
            sequence: "6",
            node: NODE_K,
            context: [],
            authority: 40,
            value: WRITER_LOCAL + ":5",
            basis: [
                { node: NODE_A, value: WRITER_LOCAL + ":3" },
                { node: NODE_B, value: WRITER_LOCAL + ":2" },
            ],
        }),
        validate({
            writer: WRITER_LOCAL,
            sequence: "7",
            node: NODE_K,
            context: [],
            authority: 35,
            value: WRITER_LOCAL + ":5",
            basis: [
                { node: NODE_A, value: WRITER_LOCAL + ":1" },
                { node: NODE_B, value: WRITER_LOCAL + ":4" },
            ],
        }),
    ];
}

/**
 * The held source target: the same three nodes materialized by a peer, with `K`
 * carrying no validity, so the target edge set is empty.
 *
 * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
 */
function sourceRecords() {
    return [
        materialize({ writer: WRITER_PEER, sequence: "1", node: NODE_A, context: [], authority: 10 }),
        materialize({ writer: WRITER_PEER, sequence: "2", node: NODE_B, context: [], authority: 12 }),
        materialize({ writer: WRITER_PEER, sequence: "3", node: NODE_K, context: [], authority: 14 }),
    ];
}

/**
 * The retained replay state the activated replica of `records` maintains.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {Promise<import("../src/generators/incremental_graph/journal_reset").RetainedReplayState>}
 */
async function retainedStateOf(records) {
    const built = await buildRetainedReplayState({
        source: makeReplicaSource(replicaOf(records)),
        localWriter: LOCAL_AUTHOR,
        currentInputKeysOfNode: kSchema,
    });
    if ("error" in built) {
        throw new Error("the receiver fixture has no retained state: " + built.error.message);
    }
    return built.state;
}

/**
 * @param {object} options
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} options.receiver
 * @param {import("../src/generators/incremental_graph/journal_reset").ResetSource} options.source
 * @param {number} [options.authority]
 * @returns {Promise<import("../src/generators/incremental_graph/journal_reset").ResetOutcome>}
 */
async function reset({ receiver, source, authority }) {
    const physical = authority === undefined ? 500 : authority;
    const last = receiver.filter((record) => journalAuthorToString(record.id.author) === WRITER_LOCAL)
        .slice(-1)[0];
    return await resetToSource({
        receiver: makeReplicaSource(replicaOf(receiver)),
        retainedState: await retainedStateOf(receiver),
        source,
        localWriter: LOCAL_AUTHOR,
        committed: {
            localWriter: LOCAL_AUTHOR,
            writerHead: last === undefined ? makeJournalSequence("0") : last.id.sequence,
            committedFrontier: contextOf(last === undefined ? [] : [[WRITER_LOCAL, last.id.sequence]]),
            authorityHighWater: authorityOf(physical),
            allocatorWatermark: 0,
        },
        observedHighWater: authorityOf(physical),
        publicationInstant: INSTANT,
        currentInputKeysOfNode: kSchema,
        receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
    });
}

/**
 * @param {import("../src/generators/incremental_graph/journal_reset").ResetOutcome} outcome
 * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
 */
function authoredOf(outcome) {
    return outcome.publication.records;
}

describe("resetToSource, the losing certificate's proof exposure", () => {
    test("the union of every eligible certificate is barriered, not only the winner's", async () => {
        const receiver = receiverWithTwoCertificates();
        const sourceJournal = makeReplicaSource(replicaOf(sourceRecords()));
        const projection = await projectRetainedJournal({
            source: sourceJournal,
            localWriter: PEER_AUTHOR,
            currentInputKeysOfNode: kSchema,
        });
        if (projection instanceof Error) {
            throw new Error("the source fixture does not project: " + projection.message);
        }
        const source = makeResetSource({
            databaseVersion: "v1",
            graphSchemeString: "scheme",
            journal: sourceJournal,
            projection,
        });

        const result = await reset({ receiver, source });
        if ("error" in result) {
            throw new Error("reset failed with " + result.error.name + ": " + result.error.message);
        }
        const outcome = result.outcome;

        // Both edges of the union are barriered, so the losing certificate C2 cannot
        // expose B and the final replay has no incoming validity for K.
        const proofBarriers = authoredOf(outcome).filter(
            (record) => record.kind === "invalidate" && record.scope.kind === "proof"
        );
        expect(proofBarriers).toHaveLength(2);
        expect(proofBarriers.every((record) => record.reason === "reset")).toBe(true);
        for (const barrier of proofBarriers) {
            expect(nodeKeyToCanonicalString(barrier.node)).toBe(KEY_K);
            expect(journalRecordIdToString(barrier.scope.value)).toBe(WRITER_LOCAL + ":5");
        }
        expect(proofBarriers.map((barrier) => nodeKeyToCanonicalString(barrier.scope.input)).sort())
            .toEqual([KEY_A, KEY_B]);

        // No target certificate is owed: the committed edge set is empty.
        expect(authoredOf(outcome).filter((record) => record.kind === "validate")).toHaveLength(0);
        const committed = outcome.projection.occurrences.find(
            (occurrence) => occurrence.nodeKeyString === KEY_K
        );
        expect(committed === undefined ? undefined : [...committed.validInputs]).toEqual([]);

        // Repeating the reset against the unchanged source authors no new barrier.
        const repeated = await reset({ receiver: [...receiver, ...outcome.records], source });
        if ("error" in repeated) {
            throw new Error("repeat reset failed with " + repeated.error.name + ": " + repeated.error.message);
        }
        expect(authoredOf(repeated.outcome).filter(
            (record) => record.kind === "invalidate" && record.scope.kind === "proof"
        )).toHaveLength(0);
        expect(authoredOf(repeated.outcome).filter((record) => record.kind === "validate")).toHaveLength(0);
    });
});
