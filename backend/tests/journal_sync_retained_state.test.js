/**
 * The retained replay state a synchronization stages, and the boundary it keeps.
 *
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary requires
 * imported and reset-authored records to update a staged summary before cutover,
 * names synchronization as an operation which must not fall back to scanning
 * retained history to obtain one, and §Derived indexes requires a maintained
 * candidate index to be updated in durable staging before the state it describes
 * becomes active. `sync.md` §Atomic publication then publishes those derived
 * indexes together with `Jfinal` and `project(Jfinal)`.
 *
 * The subject is the staged state the outcome carries. Two oracles read it here,
 * and neither is the code under test:
 *
 * - **equivalence with a rebuilt state.** `buildRetainedReplayState` reconstructs
 *   the retained state of the whole journal by traversal, which the specification
 *   permits only to maintenance. Comparing the staged state against it asks whether
 *   the staged state describes `Jfinal`, which is exactly the property a stale
 *   derivation would lose;
 * - **the read counter.** The retained-journal read surface is wrapped so every
 *   record the operation reads is counted. `$id-6845129073418625` bounds
 *   historical work by the newly admitted and affected state `C`, so the count over
 *   a receiver's retained journal must not grow with the length of that history.
 *
 * Every fixture is a supported graph plus Journal pair in the sense of
 * `incremental-graph-journal-testing.md` §Reference replay oracle.
 */

const {
    journalAuthorToString,
    journalRecordIdToString,
    makeAuthorityTime,
    makeDeleteEvent,
    makeInvalidateEvent,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeJournalSequence,
    makeNodeScope,
    makeProofScope,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    makeValueScope,
    makeWriterStateRecord,
    nodeKeyToCanonicalString,
    makeReplicaSource,
} = require("../src/generators/incremental_graph/journal");

const {
    SnapshotIdentityClass,
    synchronizeRetainedJournal,
} = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
    eligibleProofEdgeUnion,
    forkRetainedReplayState,
    isRetainedReplayState,
    projectRetainedReplay,
    refuseStaleRetainedState,
    selectedOccurrencesOf,
} = require("../src/generators/incremental_graph/journal_retained");

const NODE_A = { head: "event", args: [{ id: 1 }] };
const NODE_B = { head: "event", args: [{ id: 2 }] };
const NODE_C = { head: "event", args: [{ id: 3 }] };
const NODE_D = { head: "event", args: [{ id: 4 }] };
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
 * `C -> B -> A`, plus the unrelated leaf `D`, so a receiver's retained history can be
 * made long with records which are demonstrably not part of the change being
 * synchronized.
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
 * @param {ReadonlyArray<string>} occurrence.context
 * @param {ReadonlyArray<{node: import("../src/generators/incremental_graph/journal").NodeKey, value: string}>} occurrence.basis
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord[]}
 */
function materialize(occurrence) {
    const nodeKey = nodeKeyToCanonicalString(occurrence.node);
    const valueId = occurrence.writer + ":" + occurrence.sequence;
    const valueSequence = String(Number(occurrence.sequence) + 1);
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
                id: occurrence.writer + ":" + valueSequence,
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
 * A materialization with no validation, which makes a leaf stale on its own account
 * rather than through its inputs.
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
 * A retained-journal read surface which counts every record a consumer reads.
 *
 * `incremental-graph-journal-storage.md` §Required logical state lets a caller
 * reach retained history only one writer prefix at a time, so this wrapper adds
 * nothing the interface did not already offer: it makes the number of records the
 * operation traverses observable.
 *
 * @param {import("../src/generators/incremental_graph/journal/oracle/record_source").JournalSource} source
 * @returns {import("../src/generators/incremental_graph/journal/oracle/record_source").JournalSource & {reads: () => number, writersCalls: () => number, retainedLengthCalls: () => number}}
 */
function countingSource(source) {
    let reads = 0;
    let writersCalls = 0;
    let retainedLengthCalls = 0;
    return {
        reads: () => reads,
        writersCalls: () => writersCalls,
        retainedLengthCalls: () => retainedLengthCalls,
        writers: () => {
            writersCalls += 1;
            return source.writers();
        },
        retainedLengthOf: (author) => {
            retainedLengthCalls += 1;
            return source.retainedLengthOf(author);
        },
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
    };
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @param {number} authorityPhysical
 */
function committedAfter(records, authorityPhysical) {
    const own = records.filter((record) => journalAuthorToString(record.id.author) === WRITER_LOCAL);
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
 * The whole retained replay state of a journal, reconstructed by the maintenance
 * traversal. This is the oracle the staged state is compared against, never an input
 * synchronization is given.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {import("../src/generators/incremental_graph/journal_retained").RetainedReplayState}
 */
function rebuiltStateOf(records) {
    const built = buildRetainedReplayState({
        source: makeReplicaSource(replicaOf(records)),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        currentInputKeysOfNode: chainInputs,
    });
    if ("error" in built) {
        throw new Error("the retained state could not be rebuilt: " + built.error.message);
    }
    return built.state;
}

/**
 * The projection a retained state resolves to, read as a comparable value rather
 * than as an object with a class behind it.
 *
 * @param {import("../src/generators/incremental_graph/journal_retained").RetainedReplayState} state
 */
function resolutionOf(state) {
    const projected = projectRetainedReplay(state);
    if ("error" in projected) {
        throw new Error("the retained state did not project: " + projected.error.message);
    }
    return {
        occurrences: projected.occurrences.map((occurrence) => [
            occurrence.nodeKeyString,
            journalRecordIdToString(occurrence.valueId),
            occurrence.fresh,
            [...occurrence.validInputs].sort(),
            JSON.stringify(occurrence.payload),
        ]),
        lastNodeIndex: projected.lastNodeIndex,
        unmarkedPropagatedStaleness: [...projected.unmarkedPropagatedStaleness].sort(),
    };
}

/**
 * @param {object} options
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} options.receiver
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} options.source
 * @param {number} options.authorityPhysical
 * @param {number} [options.publicationInstant]
 * @param {import("../src/generators/incremental_graph/journal_retained").RetainedReplayState | undefined} [options.retainedState]
 */
function synchronize(options) {
    const identity = new SnapshotIdentityClass("v1", "scheme");
    const staged = options.retainedState === undefined
        ? rebuiltStateOf(options.receiver)
        : options.retainedState;
    return synchronizeRetainedJournal({
        receiver: makeReplicaSource(replicaOf(options.receiver)),
        source: makeReplicaSource(replicaOf(options.source)),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        committed: committedAfter(options.receiver, options.authorityPhysical),
        observedHighWater: authorityOf(options.authorityPhysical),
        publicationInstant: options.publicationInstant === undefined
            ? INSTANT
            : options.publicationInstant,
        currentInputKeysOfNode: chainInputs,
        receiverIdentity: identity,
        sourceIdentity: identity,
        retainedState: staged,
    });
}

/**
 * @param {{outcome: import("../src/generators/incremental_graph/journal_sync").SyncOutcome} | {error: import("../src/generators/incremental_graph/journal").JournalError}} result
 * @returns {import("../src/generators/incremental_graph/journal_sync").SyncOutcome}
 */
function outcomeOf(result) {
    if (!("outcome" in result)) {
        throw new Error("synchronization failed with " + result.error.name + ": " + result.error.message);
    }
    return result.outcome;
}

/**
 * The counted proof summary of a retained state, as one comparable value: for each
 * node which is present, the incoming edges some eligible admitted certificate can
 * currently prove.
 *
 * @param {import("../src/generators/incremental_graph/journal_retained").RetainedReplayState} state
 */
function proofSummaryOf(state) {
    /** @type {Array<[string, ReadonlyArray<string>]>} */
    const edges = [];
    for (const [nodeKeyString, occurrence] of selectedOccurrencesOf(state)) {
        const union = eligibleProofEdgeUnion({
            summary: state.proofs,
            nodeKeyString,
            valueId: occurrence.valueId,
            authorOf: (/** @type {string} */ name) => state.writers.get(name),
        });
        edges.push([nodeKeyString, [...union].sort()]);
    }
    edges.sort((left, right) => (left[0] < right[0] ? -1 : (left[0] > right[0] ? 1 : 0)));
    return edges;
}

/**
 * A supported receiver pair: `A` proven from nothing, `B` proven against `A`, and
 * `B` validating the exact `A` occurrence it observed.
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord[]}
 */
function receiverChain() {
    const a = materialize({ writer: WRITER_LOCAL, sequence: "1", node: NODE_A, context: [], basis: [] });
    const b = materialize({
        writer: WRITER_LOCAL,
        sequence: "3",
        node: NODE_B,
        context: [],
        basis: [{ node: NODE_A, value: WRITER_LOCAL + ":1" }],
    });
    return [...a, ...b];
}

/**
 * A receiver whose `A` is materialized without a proof, so `B` above it is
 * self-proof-ready and stale only through its input.
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord[]}
 */
function receiverWithUnprovenRoot() {
    const a = materializeOnly({ writer: WRITER_LOCAL, sequence: "1", node: NODE_A, context: [] });
    const b = materialize({
        writer: WRITER_LOCAL,
        sequence: "2",
        node: NODE_B,
        context: [],
        basis: [{ node: NODE_A, value: WRITER_LOCAL + ":1" }],
    });
    return [a, ...b];
}

/**
 * A peer's materialization of `C` against the receiver's `B` occurrence, observing a
 * receiver which retains `receiverHead` of its own writer's stream.
 *
 * @param {string} receiverHead
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord[]}
 */
function peerAddsC(receiverHead) {
    return materialize({
        writer: WRITER_PEER,
        sequence: "1",
        node: NODE_C,
        context: [[WRITER_LOCAL, receiverHead === undefined ? "4" : receiverHead]],
        basis: [{ node: NODE_B, value: WRITER_LOCAL + ":3" }],
    });
}

/**
 * A supported pair of materializations and validations of the unrelated leaf `D`, as
 * the receiver's own writer retained them.
 *
 * @param {number} firstSequence
 * @param {number} count
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord[]}
 */
function localLeafHistory(firstSequence, count) {
    /** @type {import("../src/generators/incremental_graph/journal").JournalRecord[]} */
    const records = [];
    for (let index = 0; index < count; index += 1) {
        records.push(...materialize({
            writer: WRITER_LOCAL,
            sequence: String(firstSequence + 2 * index),
            node: NODE_D,
            context: [],
            basis: [],
        }));
    }
    return records;
}

describe("synchronizeRetainedJournal, the retained replay state it stages", () => {
    test("the outcome carries the very state the operation extended", () => {
        const receiver = receiverChain();
        const staged = rebuiltStateOf(receiver);

        const outcome = outcomeOf(synchronize({
            receiver,
            source: peerAddsC(undefined),
            authorityPhysical: 700,
            retainedState: staged,
        }));

        expect(isRetainedReplayState(outcome.retainedState)).toBe(true);
        expect(outcome.retainedState).toBe(staged);
    });

    test("a receiver which supplies no retained replay state is refused rather than scanned", () => {
        const receiver = receiverChain();
        const identity = new SnapshotIdentityClass("v1", "scheme");

        const result = synchronizeRetainedJournal({
            receiver: makeReplicaSource(replicaOf(receiver)),
            source: makeReplicaSource(replicaOf(peerAddsC(undefined))),
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            committed: committedAfter(receiver, 700),
            observedHighWater: authorityOf(700),
            publicationInstant: INSTANT,
            currentInputKeysOfNode: chainInputs,
            receiverIdentity: identity,
            sourceIdentity: identity,
        });

        expect("outcome" in result).toBe(false);
        if ("outcome" in result) {
            return;
        }
        expect(result.error.name).toBe("JournalProjectionError");
        expect(result.error.message).toContain("retained replay state");
        expect(result.error.message).toContain("does not fall back");
    });

    test("an impostor which is not a retained replay state is refused", () => {
        const receiver = receiverChain();

        const result = synchronize({
            receiver,
            source: peerAddsC(undefined),
            authorityPhysical: 700,
            retainedState: { heads: new Map(), proofs: {} },
        });

        expect("outcome" in result).toBe(false);
    });

    test("an import-only synchronization stages exactly Jfinal", () => {
        const receiver = receiverChain();
        const outcome = outcomeOf(synchronize({
            receiver,
            source: peerAddsC(undefined),
            authorityPhysical: 700,
        }));

        expect(outcome.retainedState.proofs).toBeDefined();
        expect(resolutionOf(outcome.retainedState)).toEqual(
            resolutionOf(rebuiltStateOf([...receiver, ...outcome.records]))
        );
        expect(proofSummaryOf(outcome.retainedState)).toEqual(
            proofSummaryOf(rebuiltStateOf([...receiver, ...outcome.records]))
        );
    });

    test("a synchronization which authors structural removals stages exactly Jfinal", () => {
        const receiver = receiverChain();
        const peerDeletesA = made(makeDeleteEvent(
            {
                id: WRITER_PEER + ":1",
                context: contextOf([[WRITER_LOCAL, "4"]]),
                authorityTime: authorityOf(1),
                node: NODE_A,
            },
            "operation"
        ));

        const outcome = outcomeOf(synchronize({
            receiver,
            source: [peerDeletesA],
            authorityPhysical: 700,
        }));

        expect(outcome.publication.records.filter((record) => record.kind === "delete").length)
            .toBeGreaterThan(0);
        expect(resolutionOf(outcome.retainedState)).toEqual(
            resolutionOf(rebuiltStateOf([...receiver, ...outcome.records]))
        );
    });

    test("a synchronization which authors stale markers stages exactly Jfinal", () => {
        const receiver = receiverWithUnprovenRoot();
        const outcome = outcomeOf(synchronize({
            receiver,
            source: peerAddsC("2"),
            authorityPhysical: 700,
        }));

        expect(outcome.publication.records.filter((record) => record.kind === "invalidate").length)
            .toBeGreaterThan(0);
        expect(resolutionOf(outcome.retainedState)).toEqual(
            resolutionOf(rebuiltStateOf([...receiver, ...outcome.records]))
        );
        expect(proofSummaryOf(outcome.retainedState)).toEqual(
            proofSummaryOf(rebuiltStateOf([...receiver, ...outcome.records]))
        );
    });

    test("a synchronization which changes nothing still stages exactly Jfinal", () => {
        const receiver = receiverChain();
        const outcome = outcomeOf(synchronize({
            receiver,
            source: [],
            authorityPhysical: 700,
        }));

        expect(outcome.records).toEqual([]);
        expect(outcome.stateAdvancing).toBe(false);
        expect(resolutionOf(outcome.retainedState)).toEqual(resolutionOf(rebuiltStateOf(receiver)));
    });

    test("the staged head selection names the imported occurrence, not the superseded one", () => {
        const receiver = receiverChain();
        const peerRewritesA = materializeOnly({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_A,
            context: [[WRITER_LOCAL, "4"]],
        });

        const outcome = outcomeOf(synchronize({
            receiver,
            source: [peerRewritesA],
            authorityPhysical: 700,
        }));

        const selected = selectedOccurrencesOf(outcome.retainedState);
        expect(journalRecordIdToString(selected.get(KEY_A).valueId)).toBe(WRITER_PEER + ":1");
        expect(journalRecordIdToString(selected.get(KEY_B).valueId)).toBe(WRITER_LOCAL + ":3");
    });

    test("the staged allocator watermark is the receiver's own, unchanged by an import", () => {
        const receiver = receiverChain();
        const writerState = made(makeWriterStateRecord(WRITER_LOCAL + ":5", 42));

        const outcome = outcomeOf(synchronize({
            receiver: [...receiver, writerState],
            source: peerAddsC(undefined),
            authorityPhysical: 700,
        }));

        expect(outcome.retainedState.lastNodeIndex).toBe(42);
        expect(outcome.projection.lastNodeIndex).toBe(42);
        expect(resolutionOf(outcome.retainedState)).toEqual(
            resolutionOf(rebuiltStateOf([...receiver, writerState, ...outcome.records]))
        );
    });

    test("a second synchronization against an already incorporated source stages the same state again", () => {
        const receiver = receiverChain();
        const first = outcomeOf(synchronize({
            receiver,
            source: peerAddsC(undefined),
            authorityPhysical: 700,
        }));
        const incorporated = [...receiver, ...first.records];

        const second = outcomeOf(synchronize({
            receiver: incorporated,
            source: peerAddsC(undefined),
            authorityPhysical: 900,
        }));

        expect(second.stateAdvancing).toBe(false);
        expect(resolutionOf(second.retainedState)).toEqual(resolutionOf(rebuiltStateOf(incorporated)));
    });
});

describe("synchronizeRetainedJournal, the retained history it does not re-read", () => {
    /**
     * @param {object} options
     * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} options.receiver
     * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} options.source
     * @param {number} options.authorityPhysical
     */
    function counted(options) {
        const identity = new SnapshotIdentityClass("v1", "scheme");
        const receiver = countingSource(makeReplicaSource(replicaOf(options.receiver)));
        const source = countingSource(makeReplicaSource(replicaOf(options.source)));
        const result = synchronizeRetainedJournal({
            receiver,
            source,
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            committed: committedAfter(options.receiver, options.authorityPhysical),
            observedHighWater: authorityOf(options.authorityPhysical),
            publicationInstant: INSTANT,
            currentInputKeysOfNode: chainInputs,
            receiverIdentity: identity,
            sourceIdentity: identity,
            retainedState: rebuiltStateOf(options.receiver),
        });
        return {
            result,
            receiverReads: receiver.reads(),
            sourceReads: source.reads(),
            receiverWritersCalls: receiver.writersCalls(),
            receiverRetainedLengthCalls: receiver.retainedLengthCalls(),
        };
    }

    test("an import reads no retained receiver record at all", () => {
        const countedResult = counted({
            receiver: receiverChain(),
            source: peerAddsC(undefined),
            authorityPhysical: 700,
        });

        expect("outcome" in countedResult.result).toBe(true);
        expect(countedResult.receiverReads).toBe(0);
    });

    test("the retained reads do not grow with the receiver's retained history", () => {
        // The same change to the same node, against receivers whose retained history
        // differs by a prefix of an unrelated leaf the operation has no reason to
        // visit. A bound in terms of the retained journal makes the second count
        // exceed the first.
        const short = receiverChain();
        const long = [...short, ...localLeafHistory(5, 4)];
        const rewritesA = (/** @type {number} */ head) => [materializeOnly({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_A,
            context: [[WRITER_LOCAL, String(head)]],
        })];

        const onShort = counted({
            receiver: short,
            source: rewritesA(4),
            authorityPhysical: 9000,
        });
        const onLong = counted({
            receiver: long,
            source: rewritesA(12),
            authorityPhysical: 9000,
        });

        expect("outcome" in onShort.result).toBe(true);
        expect("outcome" in onLong.result).toBe(true);
        expect(long.length).toBeGreaterThan(short.length);
        expect(onLong.receiverReads).toBe(onShort.receiverReads);
        expect(onLong.receiverReads).toBe(0);
    });

    test("a source is read exactly its missing suffix, never the receiver's history again", () => {
        const source = peerAddsC(undefined);
        const countedResult = counted({
            receiver: receiverChain(),
            source,
            authorityPhysical: 700,
        });

        const outcome = outcomeOf(countedResult.result);
        const imported = outcome.records.filter(
            (record) => journalAuthorToString(record.id.author) === WRITER_PEER
        );
        expect(imported).toHaveLength(source.length);
        // Each suffix costs its own records plus the one read which reports the end
        // of the prefix. What the count may not do is grow with the receiver's
        // history, which is what the sibling case above holds.
        expect(countedResult.sourceReads).toBe(source.length + 1);
    });

    test("the stale-state correspondence costs one enumeration per writer, not one", () => {
        // The state names `W` admitted writers and the receiver reports `W` of its
        // own, and the check resolves an admitted writer name against the receiver's
        // writer set once per admitted writer plus once for the writers the state has
        // never admitted. The count is therefore `W + 1` enumerations and `W`
        // retained-length reads, which stays bounded by the number of writers and
        // never by the retained history.
        const receiver = [
            ...receiverChain(),
            ...localLeafHistory(5, 3),
            ...materialize({
                writer: WRITER_PEER,
                sequence: "1",
                node: NODE_C,
                context: [[WRITER_LOCAL, "4"]],
                basis: [{ node: NODE_B, value: WRITER_LOCAL + ":3" }],
            }),
        ];
        const countedReceiver = countingSource(makeReplicaSource(replicaOf(receiver)));
        const admittedWriters = new Set(
            receiver.map((record) => journalAuthorToString(record.id.author))
        ).size;
        expect(admittedWriters).toBeGreaterThan(1);

        const refused = refuseStaleRetainedState(
            rebuiltStateOf(receiver),
            countedReceiver,
            makeJournalAuthor(WRITER_LOCAL)
        );

        expect(refused).toBeUndefined();
        expect(countedReceiver.writersCalls()).toBe(admittedWriters + 1);
        expect(countedReceiver.retainedLengthCalls()).toBe(admittedWriters);
    });
});
describe("forkRetainedReplayState, the containers it hands the fold", () => {
    /**
     * Every `Map` and `Set` reachable from a value, as one comparable list.
     *
     * @param {unknown} value
     * @returns {ReadonlyArray<string>}
     */
    function containersOf(value) {
        if (value instanceof Map) {
            return [value, ...[...value.values()].flatMap((inner) => containersOf(inner))];
        }
        if (value instanceof Set) {
            return [value, ...[...value].flatMap((inner) => containersOf(inner))];
        }
        return [];
    }

    /**
     * @param {import("../src/generators/incremental_graph/journal_retained").RetainedReplayState} state
     * @returns {ReadonlyArray<unknown>}
     */
    function reachableContainers(state) {
        return [
            state.heads,
            state.proofs.selected,
            state.proofs.certificates,
            state.proofs.nodeScoped,
            state.proofs.valueScoped,
            state.proofs.proofScoped,
            state.certificates,
            state.selected,
            state.touched,
            state.writers,
            state.admittedLengths,
        ].flatMap((value) => containersOf(value));
    }

    test("the fork holds no container of the state it was taken from", () => {
        // Every scope map of the counted summary is filled by invalidations of all
        // three scope kinds, so the fork has to copy the node-scoped, value-scoped
        // and proof-scoped coordinate maxima themselves rather than only the scopes
        // which hold them: an admitted invalidation is raised by mutating the
        // innermost maximum in place.
        const receiver = [
            ...receiverChain(),
            made(makeInvalidateEvent(
                {
                    id: WRITER_LOCAL + ":5",
                    context: contextOf([]),
                    authorityTime: authorityOf(5),
                    node: NODE_A,
                },
                makeNodeScope(),
                "explicit"
            )),
            made(makeInvalidateEvent(
                {
                    id: WRITER_LOCAL + ":6",
                    context: contextOf([]),
                    authorityTime: authorityOf(6),
                    node: NODE_A,
                },
                makeValueScope(WRITER_LOCAL + ":1"),
                "propagated"
            )),
            made(makeInvalidateEvent(
                {
                    id: WRITER_LOCAL + ":7",
                    context: contextOf([]),
                    authorityTime: authorityOf(7),
                    node: NODE_A,
                },
                makeProofScope(WRITER_LOCAL + ":1", NODE_A),
                "reset"
            )),
        ];
        const state = rebuiltStateOf(receiver);
        expect(state.proofs.proofScoped.size).toBeGreaterThan(0);
        expect(state.proofs.valueScoped.size).toBeGreaterThan(0);

        const fork = forkRetainedReplayState(state);
        const shared = reachableContainers(fork)
            .filter((container) => reachableContainers(state).includes(container));

        expect(shared).toEqual([]);
    });
});
