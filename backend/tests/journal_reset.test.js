/**
 * Controlled reset of a retained Journal.
 *
 * Every fixture here is a supported graph plus Journal pair in the sense of
 * `incremental-graph-journal-testing.md` §Reference replay oracle: each record is
 * written by a writer which observed the coordinates it references and, for a
 * validation, names exactly the current direct-input occurrences it observed, so
 * both journals are well formed before reset sees them.
 *
 * The subject is `resetToSource`, which reads retained journals and a held source
 * snapshot rather than a database. That is the whole algorithm up to the
 * publication write, so these tests pin the properties `docs/specs/
 * incremental-graph-journal-reset.md` makes about reset: the raw union is repaired
 * structurally rather than rejected, an already-correct occurrence keeps its
 * `ValueId`, proof is weakened by occurrence-scoped barriers rather than by value
 * replacement, the target's stale flags are made durable, and the committed result
 * equals the target semantic graph.
 */

const {
    isJournalWriterBehindError,
    isJournalVersionCompatibilityError,
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalRecordId,
    makeJournalReplica,
    makeJournalSequence,
    makeReplicaSource,
    makeInvalidateEvent,
    makeProofScope,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    makeDeleteEvent,
    nodeKeyToCanonicalString,
    projectRetainedJournal,
    effectiveInputsOf,
    isEligibleCertificate,
    summarizeInvalidations,
} = require("../src/generators/incremental_graph/journal");

const { SnapshotIdentityClass } = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
    countEligibleProofEdges,
    eligibleProofEdgeUnion,
    isResetOutcome,
    makeResetSource,
    resetToSource,
} = require("../src/generators/incremental_graph/journal_reset");

const NODE_A = { head: "event", args: [{ id: 1 }] };
const NODE_B = { head: "event", args: [{ id: 2 }] };
const NODE_D = { head: "event", args: [{ id: 4 }] };
const KEY_A = nodeKeyToCanonicalString(NODE_A);
const KEY_B = nodeKeyToCanonicalString(NODE_B);
const KEY_D = nodeKeyToCanonicalString(NODE_D);
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const LOCAL_AUTHOR = makeJournalAuthor(WRITER_LOCAL);
const PEER_AUTHOR = makeJournalAuthor(WRITER_PEER);
const PAYLOAD = { type: "entry_description", description: "x" };
const OTHER_PAYLOAD = { type: "entry_description", description: "y" };
const INSTANT = 1700000000000;

/**
 * The schema of the two-input fixture: `B` depends on `A` and `D`, and `A` and `D`
 * are leaves. Two inputs make the difference between the edge a barrier retires and
 * the edge it leaves alone observable.
 *
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function twoInputSchema(nodeKeyString) {
    if (nodeKeyString === KEY_B) {
        return [KEY_A, KEY_D];
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
 * The coordinates a writer's record at `sequence` observed: what the caller said it
 * had seen, plus the writer's own complete already-committed prefix.
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
 * @param {number} [logical]
 */
function authorityOf(physical, logical) {
    return makeAuthorityTime(physical, String(logical === undefined ? 0 : logical));
}

/**
 * @param {import("../src/generators/incremental_graph/journal").JournalRecord} record
 */
function sequenceOf(record) {
    return Number(journalSequenceToString(record.id.sequence));
}

/**
 * @param {string} nodeKeyString
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
 * @param {string} [occurrence.payload]
 * @param {string} [occurrence.createdAt]
 * @param {string} [occurrence.modifiedAt]
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
        occurrence.payload === undefined ? PAYLOAD : occurrence.payload,
        occurrence.createdAt === undefined ? NOW : occurrence.createdAt,
        occurrence.modifiedAt === undefined ? LATER : occurrence.modifiedAt,
        "compute"
    ));
}

/**
 * One validation against the exact current inputs of its node, at the sequence the
 * caller assigns it.
 *
 * @param {object} validation
 * @param {string} validation.writer
 * @param {string} validation.sequence
 * @param {import("../src/generators/incremental_graph/journal").NodeKey} validation.node
 * @param {ReadonlyArray<string>} validation.context
 * @param {number} validation.authority
 * @param {string} validation.value - The occurrence this validation proves.
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
 * A validation of the occurrence this same writer materialized one coordinate
 * earlier, which is the ordinary shape of a writer which recomputes then proves.
 *
 * @param {object} validation
 * @param {string} validation.writer
 * @param {string} validation.valueSequence - The sequence of the materialization.
 * @param {import("../src/generators/incremental_graph/journal").NodeKey} validation.node
 * @param {ReadonlyArray<string>} validation.context
 * @param {number} validation.authority
 * @param {ReadonlyArray<{node: import("../src/generators/incremental_graph/journal").NodeKey, value: string}>} validation.basis
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
 */
function validateOwnMaterialization(validation) {
    return validate({
        ...validation,
        sequence: String(Number(validation.valueSequence) + 1),
        value: validation.writer + ":" + validation.valueSequence,
    });
}

/**
 * @param {object} deletion
 * @param {string} deletion.writer
 * @param {string} deletion.sequence
 * @param {import("../src/generators/incremental_graph/journal").NodeKey} deletion.node
 * @param {ReadonlyArray<string>} deletion.context
 * @param {number} deletion.authority
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
 */
function deletionOf(deletion) {
    return made(makeDeleteEvent(
        {
            id: deletion.writer + ":" + deletion.sequence,
            context: contextOf(deletion.context),
            authorityTime: authorityOf(deletion.authority),
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
    return made(makeJournalReplica([...byWriter.entries()]));
}

/**
 * The receiver's committed writer state after having retained exactly `records`.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @param {number} authority
 */
function committedAfter(records, authority) {
    const own = records.filter((record) => journalAuthorToString(record.id.author) === WRITER_LOCAL);
    const last = own[own.length - 1];
    return {
        localWriter: LOCAL_AUTHOR,
        writerHead: last === undefined ? makeJournalSequence("0") : last.id.sequence,
        committedFrontier: contextOf(last === undefined ? [] : [[WRITER_LOCAL, last.id.sequence]]),
        authorityHighWater: authorityOf(authority),
        allocatorWatermark: 0,
    };
}

/**
 * The held source snapshot: one cut's version, scheme, retained history and
 * committed projection together.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @param {object} [options]
 * @param {string} [options.databaseVersion]
 * @param {string} [options.graphSchemeString]
 */
function sourceSnapshotOf(records, options) {
    const settings = options === undefined ? {} : options;
    const journal = makeReplicaSource(replicaOf(records));
    const projection = projectRetainedJournal({
        source: journal,
        localWriter: PEER_AUTHOR,
        currentInputKeysOfNode: twoInputSchema,
    });
    if (projection instanceof Error) {
        throw new Error("the source fixture does not project: " + projection.message);
    }
    return makeResetSource({
        databaseVersion: settings.databaseVersion === undefined ? "v1" : settings.databaseVersion,
        graphSchemeString:
            settings.graphSchemeString === undefined ? "scheme" : settings.graphSchemeString,
        journal,
        projection,
    });
}

/**
 * The retained replay state the activated replica of `source` maintains, as the
 * persistence front loads it before a reset.
 *
 * Building it here is the maintenance traversal `incremental-graph-journal-storage.md`
 * §Change-bounded proof summary and §Derived indexes permit for a missing derived
 * index. Reset itself never performs it and refuses a receiver which does not hold
 * the state.
 *
 * @param {import("../src/generators/incremental_graph/journal").JournalSource} source
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} currentInputKeysOfNode
 * @returns {import("../src/generators/incremental_graph/journal_reset").RetainedReplayState}
 */
function retainedReplayState(source, currentInputKeysOfNode) {
    const built = buildRetainedReplayState({
        source,
        localWriter: LOCAL_AUTHOR,
        currentInputKeysOfNode,
    });
    if ("error" in built) {
        throw new Error("the receiver fixture has no retained replay state: " + built.error.message);
    }
    return built.state;
}

/**
 * @param {object} options
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} options.receiver
 * @param {import("../src/generators/incremental_graph/journal_reset").ResetSource} options.source
 * @param {number} [options.authority]
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} [options.currentInputKeysOfNode]
 * @param {import("../src/generators/incremental_graph/journal_sync").SnapshotIdentity} [options.receiverIdentity]
 * @param {number} [options.publicationInstant]
 */
function reset(options) {
    const receiver = makeReplicaSource(replicaOf(options.receiver));
    return resetToSource({
        receiver,
        retainedState: retainedReplayState(
            receiver,
            options.currentInputKeysOfNode === undefined ? twoInputSchema : options.currentInputKeysOfNode
        ),
        source: options.source,
        localWriter: LOCAL_AUTHOR,
        committed: committedAfter(options.receiver, options.authority === undefined ? 500 : options.authority),
        observedHighWater: authorityOf(options.authority === undefined ? 500 : options.authority),
        publicationInstant:
            options.publicationInstant === undefined ? INSTANT : options.publicationInstant,
        currentInputKeysOfNode:
            options.currentInputKeysOfNode === undefined ? twoInputSchema : options.currentInputKeysOfNode,
        receiverIdentity:
            options.receiverIdentity === undefined
                ? new SnapshotIdentityClass("v1", "scheme")
                : options.receiverIdentity,
    });
}

/**
 * @param {object} result
 * @returns {import("../src/generators/incremental_graph/journal_reset").ResetOutcome}
 */
function outcomeOf(result) {
    if (!("outcome" in result)) {
        throw new Error("reset failed with " + result.error.name + ": " + result.error.message);
    }
    expect(isResetOutcome(result.outcome)).toBe(true);
    return result.outcome;
}

/**
 * @param {import("../src/generators/incremental_graph/journal_reset").ResetOutcome} outcome
 */
function authoredOf(outcome) {
    return outcome.publication.records;
}

/**
 * The receiver's supported pair: `A` and `D` proven from nothing, and `B` proven
 * against both of their occurrences.
 *
 * @param {number} [base] - The authority the receiver's own records carry.
 * @param {string} [payload]
 */
function receiverProvenPair(base, payload) {
    const start = base === undefined ? 100 : base;
    const value = payload;
    return [
        materialize({
            writer: WRITER_LOCAL,
            sequence: "1",
            node: NODE_A,
            context: [],
            authority: start,
            payload: value,
        }),
        materialize({
            writer: WRITER_LOCAL,
            sequence: "3",
            node: NODE_D,
            context: [],
            authority: start + 2,
            payload: value,
        }),
        materialize({
            writer: WRITER_LOCAL,
            sequence: "5",
            node: NODE_B,
            context: [],
            authority: start + 4,
            payload: value,
        }),
        validateOwnMaterialization({
            writer: WRITER_LOCAL,
            valueSequence: "1",
            node: NODE_A,
            context: [],
            authority: start,
            basis: [],
        }),
        validateOwnMaterialization({
            writer: WRITER_LOCAL,
            valueSequence: "3",
            node: NODE_D,
            context: [],
            authority: start + 2,
            basis: [],
        }),
        validateOwnMaterialization({
            writer: WRITER_LOCAL,
            valueSequence: "5",
            node: NODE_B,
            context: [],
            authority: start + 4,
            basis: [
                { node: NODE_A, value: WRITER_LOCAL + ":1" },
                { node: NODE_D, value: WRITER_LOCAL + ":3" },
            ],
        }),
    ].sort((left, right) => sequenceOf(left) - sequenceOf(right));
}

/**
 * The source's supported pair for the same schema. `basis` names the values the
 * source's own occurrences have, so its own projection is a valid target.
 *
 * @param {ReadonlyArray<{node: import("../src/generators/incremental_graph/journal").NodeKey, value: string}>} bBasis
 * @param {object} [options]
 * @param {string} [options.payload]
 * @param {string} [options.reason] - The reason of `B`'s certificate, which is a
 *   baseline reason when the target proves nothing and therefore names `"unknown"`.
 */
function sourcePair(bBasis, options) {
    const settings = options === undefined ? {} : options;
    const payload = settings.payload;
    const records = [
        materialize({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_A,
            context: [],
            authority: 10,
            payload: payload,
        }),
        materialize({
            writer: WRITER_PEER,
            sequence: "3",
            node: NODE_D,
            context: [],
            authority: 12,
            payload: payload,
        }),
        materialize({
            writer: WRITER_PEER,
            sequence: "5",
            node: NODE_B,
            context: [],
            authority: 14,
            payload: payload,
        }),
        validateOwnMaterialization({
            writer: WRITER_PEER,
            valueSequence: "1",
            node: NODE_A,
            context: [],
            authority: 10,
            basis: [],
        }),
    ];
    if (settings.omitProofOfD !== true) {
        records.push(validateOwnMaterialization({
            writer: WRITER_PEER,
            valueSequence: "3",
            node: NODE_D,
            context: [],
            authority: 12,
            basis: [],
        }));
    }
    records.push(makeValidateEvent(
        {
            id: WRITER_PEER + ":6",
            context: contextOf([[WRITER_PEER, "5"]]),
            authorityTime: authorityOf(14),
            node: NODE_B,
        },
        WRITER_PEER + ":5",
        bBasis.map((entry) => makeValidationBasisEntry(entry.node, entry.value)),
        settings.reason === undefined ? "compute" : settings.reason
    ));
    return records.sort((left, right) => sequenceOf(left) - sequenceOf(right));
}

describe("resetToSource, refusing incompatible sources before touching history", () => {
    test("a source which declares a different database version is refused", () => {
        const result = reset({
            receiver: receiverProvenPair(),
            source: sourceSnapshotOf(sourcePair([
                { node: NODE_A, value: WRITER_PEER + ":1" },
                { node: NODE_D, value: WRITER_PEER + ":3" },
            ]), { databaseVersion: "v2" }),
        });

        expect("outcome" in result).toBe(false);
        if ("outcome" in result) {
            return;
        }
        expect(isJournalVersionCompatibilityError(result.error)).toBe(true);
    });

    test("a source which declares a different graph scheme is refused", () => {
        const result = reset({
            receiver: receiverProvenPair(),
            source: sourceSnapshotOf(sourcePair([
                { node: NODE_A, value: WRITER_PEER + ":1" },
                { node: NODE_D, value: WRITER_PEER + ":3" },
            ]), { graphSchemeString: "other-scheme" }),
        });

        expect("outcome" in result).toBe(false);
        if ("outcome" in result) {
            return;
        }
        expect(isJournalVersionCompatibilityError(result.error)).toBe(true);
    });

    test("a source ahead of the receiver for its own writer is refused before anything is authored", () => {
        const receiver = receiverProvenPair();
        const longerLocalPrefix = materialize({
            writer: WRITER_LOCAL,
            sequence: "7",
            node: NODE_A,
            context: [],
            authority: 900,
        });

        const result = reset({
            receiver,
            source: sourceSnapshotOf([...receiver, longerLocalPrefix]),
        });

        expect("outcome" in result).toBe(false);
        if ("outcome" in result) {
            return;
        }
        expect(isJournalWriterBehindError(result.error)).toBe(true);
    });
});

describe("resetToSource, establishing target presence over the raw union", () => {
    test("a union whose selected heads are not dependency-closed is repaired rather than rejected", () => {
        const receiver = receiverProvenPair();
        const peerDeletesA = deletionOf({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_A,
            context: [],
            authority: 5000,
        });
        const source = sourceSnapshotOf([peerDeletesA]);

        const result = reset({ receiver, source });

        const outcome = outcomeOf(result);
        const removals = authoredOf(outcome).filter((record) => record.kind === "delete");
        expect(removals).toHaveLength(2);
        expect(removals.every((record) => record.reason === "reset")).toBe(true);
        expect(removals.map((record) => nodeKeyToCanonicalString(record.node))).toEqual([KEY_B, KEY_D]);
        expect(outcome.projection.occurrences).toEqual([]);
    });

    test("a target absence is deleted once, and a repeated reset to it authors nothing", () => {
        const receiver = receiverProvenPair();
        const peerDeletesA = deletionOf({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_A,
            context: [],
            authority: 5000,
        });
        const source = sourceSnapshotOf([peerDeletesA]);
        const first = outcomeOf(reset({ receiver, source }));

        const retained = [...receiver, ...first.records];
        const secondReceiver = makeReplicaSource(replicaOf(retained));
        const second = resetToSource({
            receiver: secondReceiver,
            retainedState: retainedReplayState(secondReceiver, twoInputSchema),
            source,
            localWriter: LOCAL_AUTHOR,
            committed: first.publication.writerState,
            observedHighWater: first.publication.writerState.authorityHighWater,
            publicationInstant: INSTANT + 1,
            currentInputKeysOfNode: twoInputSchema,
            receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
        });
        const repeated = outcomeOf(second);

        expect(repeated.publication.records).toHaveLength(0);
        expect(repeated.changed).toBe(false);
    });

    test("a key which is historically present but selected-absent and absent from the target is left alone", () => {
        const receiver = [
            materialize({
                writer: WRITER_LOCAL,
                sequence: "1",
                node: NODE_A,
                context: [],
                authority: 100,
            }),
            deletionOf({
                writer: WRITER_LOCAL,
                sequence: "2",
                node: NODE_A,
                context: [[WRITER_LOCAL, "1"]],
                authority: 101,
            }),
            materialize({
                writer: WRITER_LOCAL,
                sequence: "3",
                node: NODE_D,
                context: [],
                authority: 102,
            }),
            validateOwnMaterialization({
                writer: WRITER_LOCAL,
                valueSequence: "3",
                node: NODE_D,
                context: [],
                authority: 102,
                basis: [],
            }),
        ];
        const source = sourceSnapshotOf(receiver);

        const outcome = outcomeOf(reset({ receiver, source }));

        expect(authoredOf(outcome)).toHaveLength(0);
        expect(outcome.changed).toBe(false);
        expect(outcome.projection.occurrences.map((occurrence) => occurrence.nodeKeyString))
            .toEqual([KEY_D]);
    });
});

describe("resetToSource, the core identity rule", () => {
    test("an occurrence which already has the target state keeps its own ValueId", () => {
        const receiver = receiverProvenPair();
        const source = sourceSnapshotOf(sourcePair([
            { node: NODE_A, value: WRITER_PEER + ":1" },
            { node: NODE_D, value: WRITER_PEER + ":3" },
        ]));

        const outcome = outcomeOf(reset({ receiver, source }));

        expect(authoredOf(outcome)).toHaveLength(0);
        expect(journalRecordIdToString(outcome.valueIds.get(KEY_B))).toBe(WRITER_LOCAL + ":5");
        expect(outcome.projection.occurrences.map((occurrence) =>
            journalRecordIdToString(occurrence.valueId))).toEqual([
            WRITER_LOCAL + ":1",
                WRITER_LOCAL + ":5",
                WRITER_LOCAL + ":3",
        ]);
        expect(outcome.projection.occurrences.every((occurrence) => occurrence.fresh)).toBe(true);
    });

    test("an import which changes no semantics still reports a persistent change", () => {
        const receiver = receiverProvenPair();
        const source = sourceSnapshotOf(sourcePair([
            { node: NODE_A, value: WRITER_PEER + ":1" },
            { node: NODE_D, value: WRITER_PEER + ":3" },
        ]));

        const outcome = outcomeOf(reset({ receiver, source }));

        expect(outcome.records.map((record) => journalRecordIdToString(record.id))).toEqual([
            WRITER_PEER + ":1",
            WRITER_PEER + ":2",
            WRITER_PEER + ":3",
            WRITER_PEER + ":4",
            WRITER_PEER + ":5",
            WRITER_PEER + ":6",
        ]);
        expect(outcome.changed).toBe(true);
    });

    test("an occurrence which does not have the target state is replaced once and proved", () => {
        const receiver = receiverProvenPair();
        const source = sourceSnapshotOf(sourcePair(
            [
                { node: NODE_A, value: WRITER_PEER + ":1" },
                { node: NODE_D, value: WRITER_PEER + ":3" },
            ],
            { payload: OTHER_PAYLOAD }
        ));

        const outcome = outcomeOf(reset({ receiver, source }));

        const authored = authoredOf(outcome);
        const occurrences = authored.filter((record) => record.kind === "value");
        expect(occurrences).toHaveLength(3);
        expect(occurrences.every((record) => record.reason === "reset")).toBe(true);
        for (const occurrence of occurrences) {
            expect(occurrence.payload).toEqual(OTHER_PAYLOAD);
            expect(occurrence.nodeIdentifier).toBe(identifierOf(nodeKeyToCanonicalString(occurrence.node)));
            expect(occurrence.createdAt).toBe(NOW);
            expect(occurrence.modifiedAt).toBe(LATER);
        }
        expect(outcome.projection.occurrences.every((occurrence) => occurrence.fresh)).toBe(true);
        expect(outcome.projection.occurrences.map((occurrence) => occurrence.payload))
            .toEqual([OTHER_PAYLOAD, OTHER_PAYLOAD, OTHER_PAYLOAD]);
        const proofs = authored.filter((record) => record.kind === "validate");
        expect(proofs).toHaveLength(3);
        expect(proofs.every((record) => record.reason === "reset")).toBe(true);
    });

    test("reset authors under the receiver's own writer and imports keep theirs", () => {
        const receiver = receiverProvenPair();
        const source = sourceSnapshotOf(sourcePair([
            { node: NODE_A, value: WRITER_PEER + ":1" },
            { node: NODE_D, value: WRITER_PEER + ":3" },
        ]));

        const outcome = outcomeOf(reset({ receiver, source }));

        for (const record of authoredOf(outcome)) {
            expect(journalAuthorToString(record.id.author)).toBe(WRITER_LOCAL);
        }
        expect(outcome.records.filter((record) =>
            journalAuthorToString(record.id.author) === WRITER_PEER)).toHaveLength(6);
        expect(outcome.publication.writerState.localWriter).toBe(LOCAL_AUTHOR);
        expect(outcome.projection.localWriter).toBe(LOCAL_AUTHOR);
        expect(outcome.publication.writerState.allocatorWatermark).toBe(0);
        expect(authoredOf(outcome).filter((record) => record.kind === "writer-state")).toHaveLength(0);
    });
});

describe("resetToSource, weakening proof with occurrence-scoped barriers", () => {
    test("every edge an eligible certificate could expose and the target does not want is barriered", () => {
        const receiver = receiverProvenPair();
        const source = sourceSnapshotOf(sourcePair(
            [{ node: NODE_A, value: "unknown" }, { node: NODE_D, value: "unknown" }],
            { reason: "migration" }
        ));

        const outcome = outcomeOf(reset({ receiver, source }));

        const barriers = authoredOf(outcome).filter((record) => record.kind === "invalidate");
        const proofBarriers = barriers.filter((record) => record.scope.kind === "proof");
        expect(proofBarriers).toHaveLength(2);
        expect(proofBarriers.every((record) => record.reason === "reset")).toBe(true);
        for (const barrier of proofBarriers) {
            expect(nodeKeyToCanonicalString(barrier.node)).toBe(KEY_B);
            expect(journalRecordIdToString(barrier.scope.value)).toBe(WRITER_LOCAL + ":5");
        }
        expect(proofBarriers.map((barrier) => nodeKeyToCanonicalString(barrier.scope.input)).sort())
            .toEqual([KEY_A, KEY_D]);

        const committed = outcome.projection.occurrences.find(
            (occurrence) => occurrence.nodeKeyString === KEY_B
        );
        expect(committed === undefined ? undefined : [...committed.validInputs]).toEqual([]);
        // The barriers leave replay yielding exactly the target's empty edge set, so
        // no target certificate is owed for this node.
        expect(authoredOf(outcome).filter((record) => record.kind === "validate")).toHaveLength(0);
    });

    test("a barrier for one edge leaves the other edge of that certificate intact", () => {
        const receiver = receiverProvenPair();
        const source = sourceSnapshotOf(sourcePair([
            { node: NODE_A, value: "unknown" },
            { node: NODE_D, value: WRITER_PEER + ":3" },
        ], { reason: "migration" }));

        const outcome = outcomeOf(reset({ receiver, source }));

        const proofBarriers = authoredOf(outcome).filter(
            (record) => record.kind === "invalidate" && record.scope.kind === "proof"
        );
        expect(proofBarriers).toHaveLength(1);
        expect(nodeKeyToCanonicalString(proofBarriers[0].scope.input)).toBe(KEY_A);
        const committed = outcome.projection.occurrences.find(
            (occurrence) => occurrence.nodeKeyString === KEY_B
        );
        expect(committed === undefined ? undefined : [...committed.validInputs]).toEqual([KEY_D]);
    });

    test("a later reset barriers the edges the earlier one left, and accumulates none twice", () => {
        const receiver = receiverProvenPair();
        const first = outcomeOf(reset({
            receiver,
            source: sourceSnapshotOf(sourcePair([
                { node: NODE_A, value: "unknown" },
                { node: NODE_D, value: WRITER_PEER + ":3" },
            ], { reason: "migration" })),
        }));
        const retained = [...receiver, ...first.records];

        const secondReceiver = makeReplicaSource(replicaOf(retained));
        const second = outcomeOf(resetToSource({
            receiver: secondReceiver,
            retainedState: retainedReplayState(secondReceiver, twoInputSchema),
            source: sourceSnapshotOf(sourcePair(
                [{ node: NODE_A, value: "unknown" }, { node: NODE_D, value: "unknown" }],
                { reason: "migration" }
            )),
            localWriter: LOCAL_AUTHOR,
            committed: first.publication.writerState,
            observedHighWater: first.publication.writerState.authorityHighWater,
            publicationInstant: INSTANT + 1,
            currentInputKeysOfNode: twoInputSchema,
            receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
        }));

        const proofBarriers = second.publication.records.filter(
            (record) => record.kind === "invalidate" && record.scope.kind === "proof"
        );
        expect(proofBarriers).toHaveLength(1);
        expect(nodeKeyToCanonicalString(proofBarriers[0].scope.input)).toBe(KEY_D);
        expect(journalRecordIdToString(proofBarriers[0].scope.value)).toBe(WRITER_LOCAL + ":5");
        expect(second.publication.records.filter((record) => record.kind === "validate")).toHaveLength(0);
    });

    test("a target which adds proof needs no barrier", () => {
        const receiver = receiverProvenPair();
        const source = sourceSnapshotOf(sourcePair(
            [
                { node: NODE_A, value: WRITER_PEER + ":1" },
                { node: NODE_D, value: WRITER_PEER + ":3" },
            ],
            { payload: OTHER_PAYLOAD }
        ));

        const outcome = outcomeOf(reset({ receiver, source }));

        expect(authoredOf(outcome).filter((record) => record.kind === "invalidate")).toHaveLength(0);
    });

    test("a target certificate names the settled occurrences of its own edges", () => {
        const receiver = receiverProvenPair();
        const source = sourceSnapshotOf(sourcePair(
            [
                { node: NODE_A, value: WRITER_PEER + ":1" },
                { node: NODE_D, value: "unknown" },
            ],
            { payload: OTHER_PAYLOAD, reason: "migration" }
        ));

        const outcome = outcomeOf(reset({ receiver, source }));

        const proofs = authoredOf(outcome).filter((record) => record.kind === "validate");
        const proofOfB = proofs.find(
            (record) => nodeKeyToCanonicalString(record.node) === KEY_B
        );
        expect(proofOfB === undefined ? undefined : proofOfB.basis.map(
            (entry) => entry.value === "unknown" ? entry.value : journalRecordIdToString(entry.value)
        )).toEqual([WRITER_LOCAL + ":7", "unknown"]);
    });

    /**
     * The receiver's supported pair in which `B` has already been given a
     * replacement occurrence: it was materialized twice by its own writer, and
     * each occurrence carries a certificate naming it. The certificate of the
     * replaced occurrence is therefore retained history whose node, inputs and
     * edges are exactly the ones the certificate of the settled occurrence names,
     * which is what makes "a barrier for one ValueId" and "a barrier for the
     * NodeKey" observably different.
     *
     * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
     */
    function receiverWithReplacedOccurrence() {
        return [
            materialize({
                writer: WRITER_LOCAL,
                sequence: "1",
                node: NODE_A,
                context: [],
                authority: 100,
            }),
            validateOwnMaterialization({
                writer: WRITER_LOCAL,
                valueSequence: "1",
                node: NODE_A,
                context: [],
                authority: 100,
                basis: [],
            }),
            materialize({
                writer: WRITER_LOCAL,
                sequence: "3",
                node: NODE_D,
                context: [],
                authority: 102,
            }),
            validateOwnMaterialization({
                writer: WRITER_LOCAL,
                valueSequence: "3",
                node: NODE_D,
                context: [],
                authority: 102,
                basis: [],
            }),
            materialize({
                writer: WRITER_LOCAL,
                sequence: "5",
                node: NODE_B,
                context: [],
                authority: 104,
                payload: OTHER_PAYLOAD,
            }),
            validateOwnMaterialization({
                writer: WRITER_LOCAL,
                valueSequence: "5",
                node: NODE_B,
                context: [],
                authority: 104,
                basis: [
                    { node: NODE_A, value: WRITER_LOCAL + ":1" },
                    { node: NODE_D, value: WRITER_LOCAL + ":3" },
                ],
            }),
            materialize({
                writer: WRITER_LOCAL,
                sequence: "7",
                node: NODE_B,
                context: [],
                authority: 106,
            }),
            validateOwnMaterialization({
                writer: WRITER_LOCAL,
                valueSequence: "7",
                node: NODE_B,
                context: [],
                authority: 106,
                basis: [
                    { node: NODE_A, value: "unknown" },
                    { node: NODE_D, value: WRITER_LOCAL + ":3" },
                ],
            }),
        ].sort((left, right) => sequenceOf(left) - sequenceOf(right));
    }

    test("a barrier for the settled ValueId leaves a replaced occurrence's certificate untainted", () => {
        const receiver = receiverWithReplacedOccurrence();
        const source = sourceSnapshotOf(sourcePair(
            [{ node: NODE_A, value: "unknown" }, { node: NODE_D, value: "unknown" }],
            { reason: "migration" }
        ));

        const outcome = outcomeOf(reset({ receiver, source }));

        // The settled occurrence is the receiver's second materialization, so the
        // barrier names it and not the occurrence it replaced. Only `D` is
        // barriered, because only the settled occurrence's own certificate proves
        // it: `A` is proved by the certificate of the occurrence this reset
        // replaced, which is not exposed to the target at all.
        const proofBarriers = authoredOf(outcome).filter(
            (record) => record.kind === "invalidate" && record.scope.kind === "proof"
        );
        expect(proofBarriers).toHaveLength(1);
        for (const barrier of proofBarriers) {
            expect(nodeKeyToCanonicalString(barrier.node)).toBe(KEY_B);
            expect(journalRecordIdToString(barrier.scope.value)).toBe(WRITER_LOCAL + ":7");
            expect(nodeKeyToCanonicalString(barrier.scope.input)).toBe(KEY_D);
        }

        // Both barriers took effect against the settled occurrence.
        const settled = outcome.projection.occurrences.find(
            (occurrence) => occurrence.nodeKeyString === KEY_B
        );
        expect(settled === undefined ? undefined : [...settled.validInputs]).toEqual([]);

        // The certificate of the replaced occurrence still proves both of its
        // edges. This is the observation the acceptance list asks for: the barrier
        // scope is one occurrence and one input, so retiring `A -> B` and
        // `D -> B` for `WRITER_LOCAL:7` leaves the identically-shaped proof of
        // `WRITER_LOCAL:5` intact even though both share a NodeKey. Reading those
        // edges back requires binding the node to the occurrence the certificate
        // names, which is what "for another ValueId" means operationally.
        const retained = makeReplicaSource(replicaOf([...receiver, ...outcome.records]));
        const replaced = projectRetainedJournal({
            source: retained,
            localWriter: LOCAL_AUTHOR,
            currentInputKeysOfNode: twoInputSchema,
        });
        if (replaced instanceof Error) {
            throw new Error("the committed journal does not project: " + replaced.message);
        }
        /** @type {Map<string, {node: import("../src/generators/incremental_graph/journal").NodeKey, valueId: import("../src/generators/incremental_graph/journal").JournalRecordId}>} */
        const occurrences = new Map(
            replaced.occurrences.map((occurrence) => [occurrence.nodeKeyString, occurrence])
        );
        occurrences.set(KEY_B, {
            node: NODE_B,
            valueId: made(makeJournalRecordId(LOCAL_AUTHOR, makeJournalSequence("5"))),
        });
        const summaries = summarizeInvalidations(retained, occurrences);
        if ("error" in summaries) {
            throw new Error("the committed journal does not summarize: " + summaries.error.message);
        }
        const authorOf = (name) => (name === WRITER_LOCAL ? LOCAL_AUTHOR : PEER_AUTHOR);
        const certificateOfReplaced = [...receiver, ...outcome.records].find(
            (record) => record.kind === "validate" &&
                journalRecordIdToString(record.value) === WRITER_LOCAL + ":5"
        );
        expect(certificateOfReplaced === undefined).toBe(false);
        const bound = {
            valueIdOf: (nodeKeyString) => {
                const occurrence = occurrences.get(nodeKeyString);
                return occurrence === undefined ? undefined : occurrence.valueId;
            },
            authorOf,
        };
        // Eligibility as well as effectiveness: a barrier which reached the node's
        // proof rather than only one of its edges would leave the edges effective
        // while ceasing to make this certificate current proof at all.
        expect(isEligibleCertificate(
            certificateOfReplaced,
            summaries.summaries,
            bound,
            twoInputSchema
        )).toBe(true);
        expect([...effectiveInputsOf(
            certificateOfReplaced,
            summaries.summaries,
            bound,
            twoInputSchema
        )].sort()).toEqual([KEY_A, KEY_D]);
    });

    /**
     * The receiver's supported pair in which `B` carries two certificates of the
     * same occurrence and an earlier proof barrier sits between them: the first
     * certificate does not observe the barrier, the second proves `D` again after
     * observing it. The edge `D -> B` is therefore proved by one certificate and
     * retired for the other, which is exactly the situation
     * `incremental-graph-journal-storage.md` §Change-bounded proof summary says a
     * count is required for: retiring it for the first certificate must not retire
     * it for the second.
     *
     * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
     */
    function receiverWithReestablishedEdge() {
        return [
            materialize({
                writer: WRITER_LOCAL,
                sequence: "1",
                node: NODE_A,
                context: [],
                authority: 100,
            }),
            validateOwnMaterialization({
                writer: WRITER_LOCAL,
                valueSequence: "1",
                node: NODE_A,
                context: [],
                authority: 100,
                basis: [],
            }),
            materialize({
                writer: WRITER_LOCAL,
                sequence: "3",
                node: NODE_D,
                context: [],
                authority: 102,
            }),
            validateOwnMaterialization({
                writer: WRITER_LOCAL,
                valueSequence: "3",
                node: NODE_D,
                context: [],
                authority: 102,
                basis: [],
            }),
            materialize({
                writer: WRITER_LOCAL,
                sequence: "5",
                node: NODE_B,
                context: [],
                authority: 104,
            }),
            validateOwnMaterialization({
                writer: WRITER_LOCAL,
                valueSequence: "5",
                node: NODE_B,
                context: [],
                authority: 104,
                basis: [
                    { node: NODE_A, value: WRITER_LOCAL + ":1" },
                    { node: NODE_D, value: WRITER_LOCAL + ":3" },
                ],
            }),
            made(makeInvalidateEvent(
                {
                    id: WRITER_LOCAL + ":7",
                    context: contextOf([[WRITER_LOCAL, "6"]]),
                    authorityTime: authorityOf(106),
                    node: NODE_B,
                },
                makeProofScope(
                    made(makeJournalRecordId(LOCAL_AUTHOR, makeJournalSequence("5"))),
                    NODE_D
                ),
                "reset"
            )),
            made(makeValidateEvent(
                {
                    id: WRITER_LOCAL + ":8",
                    context: contextOf([[WRITER_LOCAL, "7"]]),
                    authorityTime: authorityOf(108),
                    node: NODE_B,
                },
                WRITER_LOCAL + ":5",
                [
                    makeValidationBasisEntry(NODE_A, WRITER_LOCAL + ":1"),
                    makeValidationBasisEntry(NODE_D, WRITER_LOCAL + ":3"),
                ],
                "compute"
            )),
        ].sort((left, right) => sequenceOf(left) - sequenceOf(right));
    }

    test("an edge one certificate re-establishes after a barrier is still barriered", () => {
        const receiver = receiverWithReestablishedEdge();
        const source = sourceSnapshotOf(sourcePair(
            [{ node: NODE_A, value: "unknown" }, { node: NODE_D, value: "unknown" }],
            { reason: "migration" }
        ));

        const outcome = outcomeOf(reset({ receiver, source }));

        // The count of `D -> B` is one, contributed by the certificate which
        // observed the retained barrier and proved the edge again, so the edge is
        // in the union and reset barriers it. A flag which the retained barrier
        // cleared would drop it from the union, leave it exposed, and author one
        // barrier here instead of two.
        const proofBarriers = authoredOf(outcome).filter(
            (record) => record.kind === "invalidate" && record.scope.kind === "proof"
        );
        expect(proofBarriers).toHaveLength(2);
        expect(proofBarriers.map((barrier) => nodeKeyToCanonicalString(barrier.scope.input)).sort())
            .toEqual([KEY_A, KEY_D]);
        for (const barrier of proofBarriers) {
            expect(journalRecordIdToString(barrier.scope.value)).toBe(WRITER_LOCAL + ":5");
        }

        const committed = outcome.projection.occurrences.find(
            (occurrence) => occurrence.nodeKeyString === KEY_B
        );
        expect(committed === undefined ? undefined : [...committed.validInputs]).toEqual([]);

        // The count itself, read before reset authors anything: `A` is proved by
        // both certificates, `D` only by the one which observed the barrier and
        // proved it again. Both are positive, and `D`'s is positive because it is a
        // count rather than a flag the earlier barrier cleared.
        const before = retainedReplayState(makeReplicaSource(replicaOf(receiver)), twoInputSchema).proofs;
        const authorOf = (name) => (name === WRITER_LOCAL ? LOCAL_AUTHOR : undefined);
        expect(countEligibleProofEdges({
            summary: before,
            nodeKeyString: KEY_B,
            valueId: WRITER_LOCAL + ":5",
            inputKeyString: KEY_A,
            authorOf,
        })).toBe(2);
        expect(countEligibleProofEdges({
            summary: before,
            nodeKeyString: KEY_B,
            valueId: WRITER_LOCAL + ":5",
            inputKeyString: KEY_D,
            authorOf,
        })).toBe(1);

        // The summary staged for cutover with reset's own records has retired both
        // edges, so it agrees with the projection it is published beside.
        expect([...eligibleProofEdgeUnion({
            summary: outcome.retainedState.proofs,
            nodeKeyString: KEY_B,
            valueId: WRITER_LOCAL + ":5",
            authorOf,
        })]).toEqual([]);
    });
});

/**
 * The summary reset staged for cutover is maintained from the receiver's retained
 * one by admitting the records reset admits and reselecting the occurrences its
 * passes settle. Its counts must therefore be the counts a full maintenance
 * traversal of the committed journal produces, for every node and every current
 * input of the schema. A summary which kept the pre-reset occurrences, or which
 * never admitted the records reset admitted, disagrees with the journal it is
 * published beside.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} receiver
 * @param {import("../src/generators/incremental_graph/journal_reset").ResetOutcome} outcome
 */
function expectStagedSummaryIsTheCommittedSummary(receiver, outcome) {
    const committed = makeReplicaSource(replicaOf([...receiver, ...outcome.records]));
    const rebuilt = retainedReplayState(committed, twoInputSchema).proofs;
    const authorOf = (name) => (name === WRITER_LOCAL ? LOCAL_AUTHOR : PEER_AUTHOR);
    for (const occurrence of outcome.projection.occurrences) {
        const nodeKeyString = occurrence.nodeKeyString;
        const valueId = journalRecordIdToString(occurrence.valueId);
        for (const inputKeyString of twoInputSchema(nodeKeyString)) {
            expect(countEligibleProofEdges({
                summary: outcome.retainedState.proofs,
                nodeKeyString,
                valueId,
                inputKeyString,
                authorOf,
            })).toBe(countEligibleProofEdges({
                summary: rebuilt,
                nodeKeyString,
                valueId,
                inputKeyString,
                authorOf,
            }));
        }
        expect([...eligibleProofEdgeUnion({
            summary: outcome.retainedState.proofs,
            nodeKeyString,
            valueId,
            authorOf,
        })].sort()).toEqual([...eligibleProofEdgeUnion({
            summary: rebuilt,
            nodeKeyString,
            valueId,
            authorOf,
        })].sort());
    }
}

describe("resetToSource, making the target's staleness durable", () => {
    /**
     * The receiver's supported pair where `B` is proven against `A`, and neither
     * `A` nor `D` carries a certificate of its own, so `B` is self-proof-ready yet
     * stale through its input.
     *
     * @param {number} [base]
     * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
     */
    function receiverWithStaleInput(base) {
        const start = base === undefined ? 100 : base;
        return [
            materialize({
                writer: WRITER_LOCAL,
                sequence: "1",
                node: NODE_A,
                context: [],
                authority: start,
            }),
            materialize({
                writer: WRITER_LOCAL,
                sequence: "2",
                node: NODE_D,
                context: [],
                authority: start + 2,
            }),
            materialize({
                writer: WRITER_LOCAL,
                sequence: "3",
                node: NODE_B,
                context: [],
                authority: start + 4,
            }),
            validateOwnMaterialization({
                writer: WRITER_LOCAL,
                valueSequence: "3",
                node: NODE_B,
                context: [],
                authority: start + 4,
                basis: [
                    { node: NODE_A, value: WRITER_LOCAL + ":1" },
                    { node: NODE_D, value: WRITER_LOCAL + ":2" },
                ],
            }),
        ];
    }

    /**
     * The source's pair where `B` proves `A` and `A` has no certificate, so the
     * target holds both nodes stale.
     *
     * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
     */
    function sourceWithStaleInput() {
        return [
            materialize({
                writer: WRITER_PEER,
                sequence: "1",
                node: NODE_A,
                context: [],
                authority: 10,
            }),
            materialize({
                writer: WRITER_PEER,
                sequence: "2",
                node: NODE_D,
                context: [],
                authority: 12,
            }),
            materialize({
                writer: WRITER_PEER,
                sequence: "3",
                node: NODE_B,
                context: [],
                authority: 14,
            }),
            validateOwnMaterialization({
                writer: WRITER_PEER,
                valueSequence: "3",
                node: NODE_B,
                context: [],
                authority: 14,
                basis: [
                    { node: NODE_A, value: WRITER_PEER + ":1" },
                    { node: NODE_D, value: WRITER_PEER + ":2" },
                ],
            }),
        ];
    }

    test("a self-proof-ready target-stale node receives a value-scoped reset marker", () => {
        const receiver = receiverWithStaleInput();
        const source = sourceSnapshotOf(sourceWithStaleInput());

        const outcome = outcomeOf(reset({ receiver, source }));

        const markers = authoredOf(outcome).filter(
            (record) => record.kind === "invalidate" && record.scope.kind === "value"
        );
        expect(markers).toHaveLength(1);
        expect(nodeKeyToCanonicalString(markers[0].node)).toBe(KEY_B);
        expect(journalRecordIdToString(markers[0].scope.value)).toBe(WRITER_LOCAL + ":3");
        expect(markers[0].reason).toBe("reset");
        expect(outcome.projection.occurrences.every((occurrence) => !occurrence.fresh)).toBe(true);
    });

    test("a later upstream revalidation does not freshen a node the target holds stale", () => {
        const receiver = receiverWithStaleInput();
        const source = sourceSnapshotOf(sourceWithStaleInput());
        const outcome = outcomeOf(reset({ receiver, source }));
        const head = Number(journalSequenceToString(outcome.publication.writerState.writerHead));

        const laterRevalidation = made(makeValidateEvent(
            {
                id: WRITER_LOCAL + ":" + String(head + 1),
                context: contextOf([
                    [WRITER_LOCAL, String(head)],
                    [WRITER_PEER, "4"],
                ]),
                authorityTime: authorityOf(900),
                node: NODE_A,
            },
            WRITER_LOCAL + ":1",
            [],
            "unchanged"
        ));
        const afterUpstream = projectRetainedJournal({
            source: makeReplicaSource(replicaOf([...receiver, ...outcome.records, laterRevalidation])),
            localWriter: LOCAL_AUTHOR,
            currentInputKeysOfNode: twoInputSchema,
        });
        if (afterUpstream instanceof Error) {
            throw new Error("the committed journal does not project: " + afterUpstream.message);
        }

        const byKey = new Map(
            afterUpstream.occurrences.map((occurrence) => [occurrence.nodeKeyString, occurrence])
        );
        expect(byKey.get(KEY_A).fresh).toBe(true);
        expect(byKey.get(KEY_B).fresh).toBe(false);
    });

    test("a node whose own proof is not ready receives no duplicate marker", () => {
        const receiver = receiverWithStaleInput();
        const source = sourceSnapshotOf(sourceWithStaleInput());

        const outcome = outcomeOf(reset({ receiver, source }));

        expect(authoredOf(outcome).filter((record) => record.kind === "value")).toHaveLength(0);
        expect(authoredOf(outcome).filter((record) => record.kind === "validate")).toHaveLength(0);
        expect(authoredOf(outcome)).toHaveLength(1);
    });
});

/*
 * This suite is the algorithm layer: `resetToSource` returns the retained records and
 * the projection they lower to, and commits nothing itself. `reset.md` §Atomicity is
 * therefore not observable from here; the receiver exposing either the old journal plus
 * the old graph or `Jreset` plus `project(Jreset)`, and never a split, is asserted
 * against the production reset in `journal_reset_atomicity.test.js`.
 */
describe("resetToSource, maintaining the counted proof summary", () => {
    test("the staged summary is the summary of the committed journal when the target adds proof", () => {
        const receiver = receiverProvenPair();
        const outcome = outcomeOf(reset({
            receiver,
            source: sourceSnapshotOf(sourcePair(
                [
                    { node: NODE_A, value: WRITER_PEER + ":1" },
                    { node: NODE_D, value: WRITER_PEER + ":3" },
                ],
                { payload: OTHER_PAYLOAD }
            )),
        }));
        expect(authoredOf(outcome).filter((record) => record.kind === "validate").length)
            .toBeGreaterThan(0);
        expectStagedSummaryIsTheCommittedSummary(receiver, outcome);
    });

    test("the staged summary is the summary of the committed journal when an occurrence is replaced", () => {
        const receiver = receiverProvenPair();
        const outcome = outcomeOf(reset({
            receiver,
            source: sourceSnapshotOf(sourcePair(
                [
                    { node: NODE_A, value: WRITER_PEER + ":1" },
                    { node: NODE_D, value: WRITER_PEER + ":3" },
                ],
                { payload: OTHER_PAYLOAD, reason: "migration" }
            )),
        }));
        expect(authoredOf(outcome).filter((record) => record.kind === "value").length)
            .toBeGreaterThan(0);
        expectStagedSummaryIsTheCommittedSummary(receiver, outcome);
    });

    test("the staged summary counts no certificate of the occurrence reset replaced", () => {
        // The receiver proves `B` against both inputs, the target replaces `B`'s
        // occurrence and proves nothing, so at the post-value-repair cut no
        // eligible certificate names the settled occurrence and the union is empty.
        // A summary which still selected the replaced occurrence would read the
        // receiver's own certificate from it and author barriers the target does
        // not need.
        const receiver = receiverProvenPair();
        const outcome = outcomeOf(reset({
            receiver,
            source: sourceSnapshotOf(sourcePair(
                [{ node: NODE_A, value: "unknown" }, { node: NODE_D, value: "unknown" }],
                { payload: OTHER_PAYLOAD, reason: "migration" }
            )),
        }));
        const settled = outcome.valueIds.get(KEY_B);
        expect(settled === undefined ? undefined : journalRecordIdToString(settled))
            .not.toBe(WRITER_LOCAL + ":5");
        expect(authoredOf(outcome).filter(
            (record) => record.kind === "invalidate" && record.scope.kind === "proof"
        )).toHaveLength(0);
        expectStagedSummaryIsTheCommittedSummary(receiver, outcome);
    });

    test("the staged summary is the summary of the committed journal when proof is weakened", () => {
        const receiver = receiverProvenPair();
        const outcome = outcomeOf(reset({
            receiver,
            source: sourceSnapshotOf(sourcePair(
                [{ node: NODE_A, value: "unknown" }, { node: NODE_D, value: "unknown" }],
                { reason: "migration" }
            )),
        }));
        expect(authoredOf(outcome).filter(
            (record) => record.kind === "invalidate" && record.scope.kind === "proof"
        ).length).toBeGreaterThan(0);
        expectStagedSummaryIsTheCommittedSummary(receiver, outcome);
    });
});

/**
 * A `JournalSource` which counts every retained record a caller reads through it.
 *
 * @param {import("../src/generators/incremental_graph/journal").JournalSource} source
 * @returns {{source: import("../src/generators/incremental_graph/journal").JournalSource, reads: () => number}}
 */
function countingSource(source) {
    let reads = 0;
    return {
        reads: () => reads,
        source: {
            writers: () => source.writers(),
            retainedLengthOf: (author) => source.retainedLengthOf(author),
            prefixReaderOf: (author) => {
                const reader = source.prefixReaderOf(author);
                return {
                    nextRecord: () => {
                        reads += 1;
                        return reader.nextRecord();
                    },
                    failure: () => reader.failure(),
                };
            },
        },
    };
}

/**
 * A receiver whose retained history is `depth` unselected revalidations of `A`
 * under its own writer, so the records it retains are many more than the ones its
 * current state depends on.
 *
 * @param {number} depth
 */
function receiverWithRetainedRevalidations(depth) {
    const records = receiverProvenPair();
    let authority = 200;
    let sequence = 7;
    for (let index = 0; index < depth; index += 1) {
        records.push(validate({
            writer: WRITER_LOCAL,
            sequence: String(sequence),
            node: NODE_A,
            context: [],
            authority,
            value: WRITER_LOCAL + ":1",
            basis: [],
            reason: "unchanged",
        }));
        authority += 1;
        sequence += 1;
    }
    return records;
}

describe("resetToSource, reading each cut as a delta over the retained state", () => {
    test("reset reads no retained record, so retained history which changes no state changes no work", () => {
        const shallowRecords = receiverWithRetainedRevalidations(1);
        const deepRecords = receiverWithRetainedRevalidations(40);
        const shallow = countingSource(makeReplicaSource(replicaOf(shallowRecords)));
        const deep = countingSource(makeReplicaSource(replicaOf(deepRecords)));
        const target = sourceSnapshotOf(sourcePair([
            { node: NODE_A, value: "unknown" },
            { node: NODE_D, value: "unknown" },
        ], { reason: "migration" }));

        const firstOutcome = outcomeOf(resetToSource({
            receiver: shallow.source,
            retainedState: retainedReplayState(makeReplicaSource(replicaOf(shallowRecords)), twoInputSchema),
            source: target,
            localWriter: LOCAL_AUTHOR,
            committed: committedAfter(receiverWithRetainedRevalidations(1), 500),
            observedHighWater: authorityOf(500),
            publicationInstant: INSTANT,
            currentInputKeysOfNode: twoInputSchema,
            receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
        }));
        const deepOutcome = outcomeOf(resetToSource({
            receiver: deep.source,
            retainedState: retainedReplayState(makeReplicaSource(replicaOf(deepRecords)), twoInputSchema),
            source: target,
            localWriter: LOCAL_AUTHOR,
            committed: committedAfter(receiverWithRetainedRevalidations(40), 500),
            observedHighWater: authorityOf(500),
            publicationInstant: INSTANT,
            currentInputKeysOfNode: twoInputSchema,
            receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
        }));

        expect(deepOutcome.publication.records.map((record) => record.kind))
            .toEqual(firstOutcome.publication.records.map((record) => record.kind));
        expect(deep.reads()).toBe(shallow.reads());
        expect(deep.reads()).toBeLessThan(deepRecords.length);
    });

    test("the committed result equals the projection of the retained journal it will publish", () => {
        const receiver = receiverProvenPair();
        const outcome = outcomeOf(reset({
            receiver,
            source: sourceSnapshotOf(sourcePair(
                [{ node: NODE_A, value: "unknown" }, { node: NODE_D, value: "unknown" }],
                { reason: "migration" }
            )),
        }));
        const committed = projectRetainedJournal({
            source: makeReplicaSource(replicaOf([...receiver, ...outcome.records])),
            localWriter: LOCAL_AUTHOR,
            currentInputKeysOfNode: twoInputSchema,
        });
        if (committed instanceof Error) {
            throw new Error("the committed journal does not project: " + committed.message);
        }
        expect(outcome.projection.occurrences).toEqual(committed.occurrences);
        expect([...outcome.projection.selfProofReadyNodes].sort())
            .toEqual([...committed.selfProofReadyNodes].sort());
        expect([...outcome.projection.unmarkedPropagatedStaleness].sort())
            .toEqual([...committed.unmarkedPropagatedStaleness].sort());
    });

    test("a receiver without retained replay state is refused rather than replayed", () => {
        const receiver = makeReplicaSource(replicaOf(receiverProvenPair()));
        const result = resetToSource({
            receiver,
            retainedState: undefined,
            source: sourceSnapshotOf(sourcePair([
                { node: NODE_A, value: "unknown" },
                { node: NODE_D, value: "unknown" },
            ], { reason: "migration" })),
            localWriter: LOCAL_AUTHOR,
            committed: committedAfter(receiverProvenPair(), 500),
            observedHighWater: authorityOf(500),
            publicationInstant: INSTANT,
            currentInputKeysOfNode: twoInputSchema,
            receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
        });

        expect("outcome" in result).toBe(false);
    });
});
