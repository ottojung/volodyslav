/**
 * The retained-Journal synchronization algorithm.
 *
 * Every fixture here is a supported graph plus Journal pair, in the sense of
 * `incremental-graph-journal-testing.md` §Reference replay oracle: the pair is
 * built by a writer which materializes a node and then validates it against the
 * exact current direct-input occurrences it observed, so the committed Journal
 * is well formed before synchronization sees it.
 *
 * The subject is `synchronizeRetainedJournal`, which reads retained journals
 * rather than a database. That is the whole algorithm up to the publication
 * write, so these tests are the ones that pin the four properties the
 * synchronization specification makes about it.
 */

const {
    isJournalWriterBehindError,
    isJournalVersionCompatibilityError,
    journalAuthorToString,
    journalRecordIdToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalSequence,
    journalSequenceToString,
    makeJournalReplica,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    makeDeleteEvent,
    nodeKeyToCanonicalString,
    makeReplicaSource,
} = require("../src/generators/incremental_graph/journal");

const {
    isSyncOutcome,
    SnapshotIdentityClass,
    synchronizeRetainedJournal,
} = require("../src/generators/incremental_graph/journal_sync");

const NODE_A = { head: "event", args: [{ id: 1 }] };
const NODE_B = { head: "event", args: [{ id: 2 }] };
const NODE_C = { head: "event", args: [{ id: 3 }] };
const KEY_A = nodeKeyToCanonicalString(NODE_A);
const KEY_B = nodeKeyToCanonicalString(NODE_B);
const KEY_C = nodeKeyToCanonicalString(NODE_C);
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const PAYLOAD = { type: "entry_description", description: "x" };
const INSTANT = 1700000000000;

/**
 * The chain schema `A -> B -> C`. A node with no entry is a node with no direct
 * input, which is what makes it a leaf the freshness recursion can bottom out on.
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function chainInputs(nodeKeyString) {
    if (nodeKeyString === KEY_B) {
        return [KEY_A];
    }
    if (nodeKeyString === KEY_C) {
        return [KEY_B];
    }
    return [];
}

/**
 * @param {ReadonlyArray<string>} coordinates
 */
function contextOf(coordinates) {
    return makeJournalFrontierFromText(coordinates);
}

/**
 * The coordinates a writer's record at `sequence` observed: what the caller saw
 * plus the writer's own complete already-committed prefix.
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
 * Assert that a synchronization succeeded, reporting the failure it produced.
 *
 * @param {{outcome: import("../src/generators/incremental_graph/journal_sync").SyncOutcome} | {error: import("../src/generators/incremental_graph/journal").JournalError}} result
 * @returns {import("../src/generators/incremental_graph/journal_sync").SyncOutcome}
 */
function outcomeOf(result) {
    if (!("outcome" in result)) {
        throw new Error("synchronization failed with " + result.error.name + ": " + result.error.message);
    }
    expect(isSyncOutcome(result.outcome)).toBe(true);
    return result.outcome;
}

/**
 * Fail the fixture at its own construction rather than inside the algorithm.
 *
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
 * @param {number} [logical]
 */
function authorityOf(physical, logical) {
    return makeAuthorityTime(physical, String(logical === undefined ? 0 : logical));
}

/**
 * @param {string} nodeKeyString
 */
function identifierOf(nodeKeyString) {
    return JSON.parse(nodeKeyString).args[0].id + "-abcdefghi";
}

/**
 * The one materialization-and-validation pair of a node, as the writer which
 * produced it retained it.
 *
 * @param {object} occurrence
 * @param {string} occurrence.writer
 * @param {string} occurrence.sequence
 * @param {import("../src/generators/incremental_graph/journal").NodeKey} occurrence.node
 * @param {ReadonlyArray<string>} occurrence.context - The writer-local coordinates
 *   the materialization observed, before its own coordinate.
 * @param {ReadonlyArray<{node: import("../src/generators/incremental_graph/journal").NodeKey, value: string}>} occurrence.basis
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord[]}
 */
function materialize(occurrence) {
    const nodeKey = nodeKeyToCanonicalString(occurrence.node);
    const valueId = occurrence.writer + ":" + occurrence.sequence;
    const valueSequence = String(Number(occurrence.sequence) + 1);
    const validateId = occurrence.writer + ":" + valueSequence;
    return [
        made(makeValueEvent(
            {
                id: valueId,
                context: contextOf(observedUpTo(occurrence.writer, occurrence.sequence, occurrence.context)),
                authorityTime: authorityOf(Number(occurrence.sequence)),
                node: occurrence.node,
            },
            identifierOf(nodeKey),
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        )),
        made(makeValidateEvent(
            {
                id: validateId,
                context: contextOf(observedUpTo(occurrence.writer, valueSequence, occurrence.context)),
                authorityTime: authorityOf(Number(valueSequence)),
                node: occurrence.node,
            },
            valueId,
            occurrence.basis.map((entry) => makeValidationBasisEntry(entry.node, entry.value)),
            "compute"
        )),
    ];
}

/**
 * A materialization with no validation, which is how a leaf becomes stale without
 * being self-proof-ready: its own proof is not ready, so no marker is owed for it.
 *
 * @param {object} occurrence
 * @param {string} occurrence.writer
 * @param {string} occurrence.sequence
 * @param {import("../src/generators/incremental_graph/journal").NodeKey} occurrence.node
 * @param {ReadonlyArray<string>} occurrence.context
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
 */
function materializeOnly(occurrence) {
    return made(makeValueEvent(
        {
            id: occurrence.writer + ":" + occurrence.sequence,
            context: contextOf(observedUpTo(occurrence.writer, occurrence.sequence, occurrence.context)),
            authorityTime: authorityOf(Number(occurrence.sequence)),
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
 * A peer's deletion of one node, observed on the receiver's own prefix.
 *
 * @param {object} deletion
 * @param {string} deletion.writer
 * @param {string} deletion.sequence
 * @param {import("../src/generators/incremental_graph/journal").NodeKey} deletion.node
 * @param {ReadonlyArray<string>} deletion.context
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
 */
function deletionOf(deletion) {
    return made(makeDeleteEvent(
        {
            id: deletion.writer + ":" + deletion.sequence,
            context: contextOf(deletion.context),
            authorityTime: authorityOf(Number(deletion.sequence)),
            node: deletion.node,
        },
        "operation"
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
 * The receiver's committed writer state after having retained exactly `records`.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @param {number} authorityPhysical
 */
function committedAfter(records, authorityPhysical) {
    const own = records.filter(
        (record) => journalAuthorToString(record.id.author) === WRITER_LOCAL
    );
    const last = own[own.length - 1];
    return {
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        writerHead: last === undefined ? makeJournalSequence("0") : last.id.sequence,
        committedFrontier: contextOf(
            last === undefined ? [] : [[WRITER_LOCAL, last.id.sequence]]
        ),
        authorityHighWater: authorityOf(authorityPhysical),
        allocatorWatermark: 0,
    };
}

/**
 * @param {object} options
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} options.receiver
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} options.source
 * @param {number} options.authorityPhysical - The greatest authority the receiver has observed.
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} [options.currentInputKeysOfNode]
 * @param {import("../src/generators/incremental_graph/journal_sync").SnapshotIdentity} [options.receiverIdentity]
 * @param {import("../src/generators/incremental_graph/journal_sync").SnapshotIdentity} [options.sourceIdentity]
 * @param {number} [options.publicationInstant]
 */
function synchronize(options) {
    const identity = new SnapshotIdentityClass("v1", "scheme");
    return synchronizeRetainedJournal({
        receiver: makeReplicaSource(replicaOf(options.receiver)),
        source: makeReplicaSource(replicaOf(options.source)),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        committed: committedAfter(options.receiver, options.authorityPhysical),
        observedHighWater: authorityOf(options.authorityPhysical),
        publicationInstant: options.publicationInstant === undefined
            ? INSTANT
            : options.publicationInstant,
        currentInputKeysOfNode: options.currentInputKeysOfNode === undefined
            ? chainInputs
            : options.currentInputKeysOfNode,
        receiverIdentity: options.receiverIdentity === undefined ? identity : options.receiverIdentity,
        sourceIdentity: options.sourceIdentity === undefined ? identity : options.sourceIdentity,
    });
}

/**
 * The receiver's supported pair for the chain schema: A proven from nothing, B
 * proven against A's occurrence, and B's occurrence the one B's proof names.
 */
function receiverChain() {
    const a = materialize({
        writer: WRITER_LOCAL,
        sequence: "1",
        node: NODE_A,
        context: [],
        basis: [],
    });
    const b = materialize({
        writer: WRITER_LOCAL,
        sequence: "3",
        node: NODE_B,
        context: [],
        basis: [{ node: NODE_A, value: WRITER_LOCAL + ":1" }],
    });
    return [...a, ...b];
}

describe("synchronizeRetainedJournal, acquiring foreign-writer suffixes", () => {
    test("an imported occurrence arrives as its own writer's record, and the receiver authors no value", () => {
        const receiver = receiverChain();
        const peerMaterialization = materialize({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_C,
            context: [[WRITER_LOCAL, "4"]],
            basis: [{ node: NODE_B, value: WRITER_LOCAL + ":3" }],
        });

        const result = synchronize({
            receiver,
            source: peerMaterialization,
            authorityPhysical: 400,
        });

        const outcome = outcomeOf(result);
        expect(outcome.records.map((record) => journalRecordIdToString(record.id))).toEqual([
            WRITER_PEER + ":1",
            WRITER_PEER + ":2",
        ]);
        expect(outcome.records.map((record) => record.kind)).toEqual(["value", "validate"]);
        expect(outcome.records.map((record) => journalAuthorToString(record.id.author))).toEqual([
            WRITER_PEER,
            WRITER_PEER,
        ]);
        expect(outcome.projection.occurrences.map((occurrence) => occurrence.nodeKeyString)).toEqual([
            KEY_A,
            KEY_B,
            KEY_C,
        ]);
        expect(outcome.projection.occurrences.every((occurrence) => occurrence.fresh)).toBe(true);
    });

    test("a repeated synchronization against the same source authors nothing and does not advance state", () => {
        const receiver = receiverChain();
        const peerMaterialization = materialize({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_C,
            context: [[WRITER_LOCAL, "4"]],
            basis: [{ node: NODE_B, value: WRITER_LOCAL + ":3" }],
        });
        const first = synchronize({ receiver, source: peerMaterialization, authorityPhysical: 400 });
        expect("outcome" in first).toBe(true);
        if (!("outcome" in first)) {
            return;
        }
        expect(first.outcome.stateAdvancing).toBe(true);

        const identity = new SnapshotIdentityClass("v1", "scheme");
        const second = synchronizeRetainedJournal({
            receiver: makeReplicaSource(replicaOf([...receiver, ...first.outcome.records])),
            source: makeReplicaSource(replicaOf(peerMaterialization)),
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            committed: first.outcome.publication.writerState,
            observedHighWater: first.outcome.publication.writerState.authorityHighWater,
            publicationInstant: INSTANT + 1,
            currentInputKeysOfNode: chainInputs,
            receiverIdentity: identity,
            sourceIdentity: identity,
        });

        const repeated = outcomeOf(second);
        expect(repeated.publication.records).toEqual([]);
        expect(repeated.stateAdvancing).toBe(false);
        expect(repeated.projection.occurrences.map((occurrence) => occurrence.nodeKeyString))
            .toEqual([KEY_A, KEY_B, KEY_C]);
    });

    test("a source which is ahead for the receiver's own writer is refused before anything is admitted", () => {
        const receiver = receiverChain();
        const longerLocalPrefix = materialize({
            writer: WRITER_LOCAL,
            sequence: "5",
            node: NODE_A,
            context: [],
            basis: [],
        });

        const result = synchronize({
            receiver,
            source: longerLocalPrefix,
            authorityPhysical: 400,
        });

        expect("outcome" in result).toBe(false);
        if ("outcome" in result) {
            return;
        }
        expect(isJournalWriterBehindError(result.error)).toBe(true);
    });

    test("a source which declares a different database version is refused before anything is admitted", () => {
        const result = synchronize({
            receiver: receiverChain(),
            source: [],
            authorityPhysical: 400,
            sourceIdentity: new SnapshotIdentityClass("v2", "scheme"),
        });

        expect("outcome" in result).toBe(false);
        if ("outcome" in result) {
            return;
        }
        expect(isJournalVersionCompatibilityError(result.error)).toBe(true);
    });

    test("a source which declares a different graph scheme is refused before anything is admitted", () => {
        const result = synchronize({
            receiver: receiverChain(),
            source: [],
            authorityPhysical: 400,
            sourceIdentity: new SnapshotIdentityClass("v1", "other-scheme"),
        });

        expect("outcome" in result).toBe(false);
        if ("outcome" in result) {
            return;
        }
        expect(isJournalVersionCompatibilityError(result.error)).toBe(true);
    });
});

describe("synchronizeRetainedJournal, removing the dependency closure a union leaves open", () => {
    test("an occurrence whose required direct input the union no longer selects is removed for sync", () => {
        const receiver = receiverChain();
        const peerDeletesA = deletionOf({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_A,
            context: [[WRITER_LOCAL, "4"]],
        });

        const result = synchronize({
            receiver,
            source: [peerDeletesA],
            authorityPhysical: 700,
        });

        const outcome = outcomeOf(result);
        const removals = outcome.publication.records.filter(
            (record) => record.kind === "delete"
        );
        expect(removals).toHaveLength(1);
        expect(removals[0].reason).toBe("sync");
        expect(nodeKeyToCanonicalString(removals[0].node)).toBe(KEY_B);
        expect(outcome.projection.occurrences).toEqual([]);
    });

    test("the closure is ordered cause before dependent", () => {
        const receiver = receiverChain();
        const peerAddsC = materialize({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_C,
            context: [[WRITER_LOCAL, "4"]],
            basis: [{ node: NODE_B, value: WRITER_LOCAL + ":3" }],
        });
        const peerDeletesA = deletionOf({
            writer: WRITER_PEER,
            sequence: "3",
            node: NODE_A,
            context: [[WRITER_LOCAL, "4"], [WRITER_PEER, "2"]],
        });

        const result = synchronize({
            receiver,
            source: [...peerAddsC, peerDeletesA],
            authorityPhysical: 700,
        });

        const outcome = outcomeOf(result);
        const removals = outcome.publication.records.filter(
            (record) => record.kind === "delete"
        );
        expect(removals.map((record) => nodeKeyToCanonicalString(record.node))).toEqual([
            KEY_B,
            KEY_C,
        ]);
        expect(removals.every((record) => record.reason === "sync")).toBe(true);
    });

    test("an occurrence whose required direct inputs the union still selects is left alone", () => {
        const receiver = receiverChain();
        const peerAddsC = materialize({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_C,
            context: [[WRITER_LOCAL, "4"]],
            basis: [{ node: NODE_B, value: WRITER_LOCAL + ":3" }],
        });

        const result = synchronize({
            receiver,
            source: peerAddsC,
            authorityPhysical: 700,
        });

        const outcome = outcomeOf(result);
        expect(outcome.publication.records.filter((record) => record.kind === "delete"))
            .toEqual([]);
        expect(outcome.projection.occurrences).toHaveLength(3);
    });
});

describe("synchronizeRetainedJournal, persisting propagated staleness", () => {
    /**
     * `E -> D -> B` in the chain schema: A is materialized without a proof, so it
     * is stale on its own account; B's proof is complete, so B is self-proof-ready
     * and stale only because A is stale.
     */
    function receiverWithUnprovenRoot() {
        const a = materializeOnly({
            writer: WRITER_LOCAL,
            sequence: "1",
            node: NODE_A,
            context: [],
        });
        const b = materialize({
            writer: WRITER_LOCAL,
            sequence: "2",
            node: NODE_B,
            context: [],
            basis: [{ node: NODE_A, value: WRITER_LOCAL + ":1" }],
        });
        return [a, ...b];
    }

    test("a self-proof-ready occurrence stale only through its inputs is marked for sync", () => {
        const receiver = receiverWithUnprovenRoot();
        const peerAddsC = materialize({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_C,
            context: [[WRITER_LOCAL, "3"]],
            basis: [{ node: NODE_B, value: WRITER_LOCAL + ":2" }],
        });

        const result = synchronize({
            receiver,
            source: peerAddsC,
            authorityPhysical: 700,
        });

        const outcome = outcomeOf(result);
        const markers = outcome.publication.records.filter(
            (record) => record.kind === "invalidate"
        );
        expect(markers.map((record) => nodeKeyToCanonicalString(record.node))).toEqual([
            KEY_B,
            KEY_C,
        ]);
        expect(markers.every((record) => record.reason === "sync")).toBe(true);
        expect(markers.every((record) => record.scope.kind === "value")).toBe(true);
        expect(outcome.projection.unmarkedPropagatedStaleness.size).toBe(0);
    });

    test("an occurrence whose own proof is incomplete is not marked, because the deficit is its own", () => {
        const receiver = receiverWithUnprovenRoot();

        const result = synchronize({
            receiver,
            source: [],
            authorityPhysical: 400,
        });

        const outcome = outcomeOf(result);
        const markers = outcome.publication.records;
        expect(markers.every((record) => nodeKeyToCanonicalString(record.node) !== KEY_A)).toBe(true);
        expect(outcome.projection.unmarkedPropagatedStaleness.size).toBe(0);
        expect(outcome.projection.occurrences.map((occurrence) => [
            occurrence.nodeKeyString,
            occurrence.fresh,
        ])).toEqual([[KEY_A, false], [KEY_B, false]]);
    });

    test("a peer occurrence which supersedes a proven input leaves its own basis deficit uncompensated", () => {
        const receiver = receiverChain();
        const peerRewritesA = materializeOnly({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_A,
            context: [[WRITER_LOCAL, "4"]],
        });

        const result = synchronize({
            receiver,
            source: [peerRewritesA],
            authorityPhysical: 700,
        });

        const outcome = outcomeOf(result);
        // B's proof names the peer's superseded A occurrence, so its effective basis
        // is empty and its staleness is a basis deficit rather than propagated
        // staleness, which the specification does not ask a marker for.
        expect(outcome.publication.records).toEqual([]);
        expect(outcome.projection.unmarkedPropagatedStaleness.size).toBe(0);
        expect(outcome.projection.occurrences.map((occurrence) => [
            occurrence.nodeKeyString,
            occurrence.fresh,
            [...occurrence.validInputs],
        ])).toEqual([[KEY_A, false, []], [KEY_B, false, []]]);
    });

    test("every marker names the occurrence the projection selected, not a superseded one", () => {
        const receiver = receiverWithUnprovenRoot();
        const peerAddsC = materialize({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_C,
            context: [[WRITER_LOCAL, "3"]],
            basis: [{ node: NODE_B, value: WRITER_LOCAL + ":2" }],
        });

        const result = synchronize({
            receiver,
            source: peerAddsC,
            authorityPhysical: 700,
        });

        const outcome = outcomeOf(result);
        const selected = new Map(
            outcome.projection.occurrences.map((occurrence) => [
                occurrence.nodeKeyString,
                journalRecordIdToString(occurrence.valueId),
            ])
        );
        for (const marker of outcome.publication.records) {
            if (marker.kind !== "invalidate" || marker.scope.kind !== "value") {
                continue;
            }
            expect(journalRecordIdToString(marker.scope.value))
                .toBe(selected.get(nodeKeyToCanonicalString(marker.node)));
        }
    });
});

describe("synchronizeRetainedJournal, the allocation of the records it authors", () => {
    test("every authored record consumes the next receiver coordinate and is contiguous", () => {
        const receiver = receiverChain();
        const peerAddsC = materialize({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_C,
            context: [[WRITER_LOCAL, "4"]],
            basis: [{ node: NODE_B, value: WRITER_LOCAL + ":3" }],
        });
        const peerDeletesA = deletionOf({
            writer: WRITER_PEER,
            sequence: "3",
            node: NODE_A,
            context: [[WRITER_LOCAL, "4"], [WRITER_PEER, "2"]],
        });

        const result = synchronize({
            receiver,
            source: [...peerAddsC, peerDeletesA],
            authorityPhysical: 700,
        });

        const outcome = outcomeOf(result);
        const authored = outcome.publication.records;
        expect(authored.length).toBeGreaterThan(0);
        expect(authored.map((record) => journalRecordIdToString(record.id))).toEqual(
            authored.map((record, index) => WRITER_LOCAL + ":" + String(5 + index))
        );
        expect(journalSequenceToString(outcome.publication.writerState.writerHead))
            .toBe(String(4 + authored.length));
    });

    test("every authored context observes the complete imported frontier with an exact own prefix", () => {
        const receiver = receiverChain();
        const peerAddsC = materialize({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_C,
            context: [[WRITER_LOCAL, "4"]],
            basis: [{ node: NODE_B, value: WRITER_LOCAL + ":3" }],
        });
        const peerDeletesA = deletionOf({
            writer: WRITER_PEER,
            sequence: "3",
            node: NODE_A,
            context: [[WRITER_LOCAL, "4"], [WRITER_PEER, "2"]],
        });

        const result = synchronize({
            receiver,
            source: [...peerAddsC, peerDeletesA],
            authorityPhysical: 700,
        });

        const outcome = outcomeOf(result);
        for (const record of outcome.publication.records) {
            if (record.kind === "writer-state") {
                continue;
            }
            const own = [...record.context].find(
                (coordinate) => journalAuthorToString(coordinate[0]) === WRITER_LOCAL
            );
            expect(own).not.toBeUndefined();
            expect(journalSequenceToString(own[1])).toBe(
                String(Number(journalSequenceToString(record.id.sequence)) - 1)
            );
            const peer = [...record.context].find(
                (coordinate) => journalAuthorToString(coordinate[0]) === WRITER_PEER
            );
            expect(peer).not.toBeUndefined();
            expect(journalSequenceToString(peer[1])).toBe("3");
        }
    });

    test("authored authority strictly extends the greatest observed authority time", () => {
        const receiver = receiverChain();
        const peerAddsC = materialize({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_C,
            context: [[WRITER_LOCAL, "4"]],
            basis: [{ node: NODE_B, value: WRITER_LOCAL + ":3" }],
        });
        const peerDeletesA = deletionOf({
            writer: WRITER_PEER,
            sequence: "3",
            node: NODE_A,
            context: [[WRITER_LOCAL, "4"], [WRITER_PEER, "2"]],
        });

        const result = synchronize({
            receiver,
            source: [...peerAddsC, peerDeletesA],
            authorityPhysical: 700,
            publicationInstant: 1000,
        });

        const outcome = outcomeOf(result);
        const physical = outcome.publication.records.map(
            (record) => record.authorityTime.physical
        );
        expect(Math.min(...physical)).toBeGreaterThan(700);
    });

    test("a synchronization authors no record kind other than the two structural reasons", () => {
        const receiver = receiverChain();
        const peerAddsC = materialize({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_C,
            context: [[WRITER_LOCAL, "4"]],
            basis: [{ node: NODE_B, value: WRITER_LOCAL + ":3" }],
        });
        const peerDeletesA = deletionOf({
            writer: WRITER_PEER,
            sequence: "3",
            node: NODE_A,
            context: [[WRITER_LOCAL, "4"], [WRITER_PEER, "2"]],
        });

        const result = synchronize({
            receiver,
            source: [...peerAddsC, peerDeletesA],
            authorityPhysical: 700,
        });

        const outcome = outcomeOf(result);
        for (const record of outcome.publication.records) {
            expect(["delete", "invalidate"]).toContain(record.kind);
            if (record.kind !== "invalidate") {
                continue;
            }
            expect(record.scope.kind).toBe("value");
            expect(record.reason).toBe("sync");
        }
    });
});
