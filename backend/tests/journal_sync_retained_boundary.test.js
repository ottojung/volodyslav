/**
 * The two boundaries the receiver's retained replay state is crossed by.
 *
 * The retained replay state is derived state the receiver hands to synchronization,
 * and `incremental-graph-journal-storage.md` §Change-bounded proof summary is explicit
 * about both ways it may be wrong:
 *
 * - a **stale** state, meaning one which does not describe the journal the operation is
 *   asked about, "requires explicit rebuild/maintenance" rather than consumption. A
 *   synchronization which consumed one would project from a journal the receiver does
 *   not retain and report success over the result, silently omitting the retained nodes
 *   that state has never seen;
 * - and because that state is the receiver's active in-memory derived state,
 *   `incremental-graph-journal-sync.md` §Atomic publication requires a failure before
 *   cutover to leave the previous active supported state selected. Extending the
 *   caller's own state in place violates that, because the state then describes records
 *   the receiver never committed.
 *
 * Both are checked here against the real operation, on a supported graph plus Journal
 * pair in the sense of `incremental-graph-journal-testing.md` §Reference replay oracle.
 * Nothing in this file reconstructs the operation's decision: the stale cases are
 * staged by handing the operation a state built by the maintenance traversal over a
 * *different* journal than the receiver's, and the mutation case is observed by
 * comparing every field of the caller's state across a synchronization which fails.
 */

const {
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    isJournalSequence,
    makeJournalSequence,
    makeInvalidateEvent,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    makeValueScope,
    nodeKeyToCanonicalString,
    makeReplicaSource,
} = require("../src/generators/incremental_graph/journal");

const {
    SnapshotIdentityClass,
    synchronizeRetainedJournal,
} = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
} = require("../src/generators/incremental_graph/journal_retained");

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
const PAYLOAD = { type: "entry_description", description: "x" };
const INSTANT = 1700000000000;

/**
 * `B -> A`, plus the unrelated leaf `D`, so a receiver and a stale copy of it can
 * differ by records which are not part of any change being synchronized.
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function chainInputs(nodeKeyString) {
    return nodeKeyString === KEY_B ? [KEY_A] : [];
}

/**
 * @param {ReadonlyArray<string>} coordinates
 */
function contextOf(coordinates) {
    return makeJournalFrontierFromText(coordinates);
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
 */
function authorityOf(physical) {
    return makeAuthorityTime(physical, "0");
}

/**
 * @param {string} nodeKeyString
 */
function identifierOf(nodeKeyString) {
    return JSON.parse(nodeKeyString).args[0].id + "-abcdefghi";
}

/**
 * One materialization and its validation, as the writer which produced it retained it.
 *
 * @param {object} occurrence
 * @param {string} occurrence.writer
 * @param {string} occurrence.sequence
 * @param {import("../src/generators/incremental_graph/journal").NodeKey} occurrence.node
 * @param {ReadonlyArray<string>} occurrence.context
 * @param {ReadonlyArray<{node: import("../src/generators/incremental_graph/journal").NodeKey, value: string}>} occurrence.basis
 * @param {string} [occurrence.identifier] - The physical node identifier to assign,
 *   which defaults to the one the node's own key implies.
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord[]}
 */
function materialize(occurrence) {
    const nodeKey = nodeKeyToCanonicalString(occurrence.node);
    const valueId = occurrence.writer + ":" + occurrence.sequence;
    const valueSequence = String(Number(occurrence.sequence) + 1);
    const observed = Number(occurrence.sequence) - 1 === 0
        ? [...occurrence.context]
        : [...occurrence.context, [occurrence.writer, String(Number(occurrence.sequence) - 1)]];
    const observedByValue = Number(valueSequence) - 1 === 0
        ? [...occurrence.context]
        : [...occurrence.context, [occurrence.writer, String(Number(valueSequence) - 1)]];
    return [
        made(makeValueEvent(
            {
                id: valueId,
                context: contextOf(observed),
                authorityTime: authorityOf(Number(occurrence.sequence)),
                node: occurrence.node,
            },
            occurrence.identifier === undefined ? identifierOf(nodeKey) : occurrence.identifier,
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        )),
        made(makeValidateEvent(
            {
                id: occurrence.writer + ":" + valueSequence,
                context: contextOf(observedByValue),
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
 * The whole retained replay state of a journal, reconstructed by the maintenance
 * traversal, which is what a state which describes that journal looks like.
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
 * @param {object} options
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} options.receiver
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} options.source
 * @param {number} options.authorityPhysical
 * @param {import("../src/generators/incremental_graph/journal_retained").RetainedReplayState} options.retainedState
 */
function synchronize(options) {
    const identity = new SnapshotIdentityClass("v1", "scheme");
    return synchronizeRetainedJournal({
        receiver: makeReplicaSource(replicaOf(options.receiver)),
        source: makeReplicaSource(replicaOf(options.source)),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        committed: committedAfter(options.receiver, options.authorityPhysical),
        observedHighWater: authorityOf(options.authorityPhysical),
        publicationInstant: INSTANT,
        currentInputKeysOfNode: chainInputs,
        receiverIdentity: identity,
        sourceIdentity: identity,
        retainedState: options.retainedState,
    });
}

/**
 * A receiver which retains `A` proven from nothing and `B` proven against `A`'s exact
 * occurrence.
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord[]}
 */
function receiverChain() {
    return [
        ...materialize({ writer: WRITER_LOCAL, sequence: "1", node: NODE_A, context: [], basis: [] }),
        ...materialize({
            writer: WRITER_LOCAL,
            sequence: "3",
            node: NODE_B,
            context: [],
            basis: [{ node: NODE_A, value: WRITER_LOCAL + ":1" }],
        }),
    ];
}

/**
 * Every readable field of a retained replay state, as one comparable value. A change
 * to any of them is a change to the state a caller holds.
 *
 * The counted summary's scope maps nest a coordinate maximum inside the scope they
 * belong to, and `String` of a `Map` is `"[object Map]"` for every entry of it, so the
 * scopes are read all the way down: a snapshot which stopped at the scope key would
 * report the same value for every state whose outermost scopes are identical, which is
 * exactly where an invalidation's coordinate maximum is written.
 *
 * @param {import("../src/generators/incremental_graph/journal_retained").RetainedReplayState} state
 */
function stateSnapshot(state) {
    /**
     * @param {unknown} value
     * @returns {unknown}
     */
    const deep = (value) => {
        if (value instanceof Map) {
            return [...value.entries()].map(([key, inner]) => [key, deep(inner)]);
        }
        if (value instanceof Set) {
            return [...value].map((inner) => deep(inner)).sort();
        }
        if (isJournalSequence(value)) {
            return journalSequenceToString(value);
        }
        return String(value);
    };
    /**
     * @param {ReadonlyMap<string, unknown>} entries
     * @returns {ReadonlyArray<[string, unknown]>}
     */
    const text = (entries) => [...entries]
        .map(([key, value]) => [String(key), deep(value)])
        .sort((left, right) => (left[0] < right[0] ? -1 : (left[0] > right[0] ? 1 : 0)));
    return {
        heads: [...state.heads.entries()]
            .map(([nodeKeyString, selection]) => [
                nodeKeyString,
                selection.winner === undefined
                    ? "absent"
                    : journalRecordIdToString(selection.winner.id),
            ])
            .sort((left, right) => (left[0] < right[0] ? -1 : (left[0] > right[0] ? 1 : 0))),
        summarySelected: text(state.proofs.selected),
        summaryCertificates: text(state.proofs.certificates),
        nodeScoped: text(state.proofs.nodeScoped),
        valueScoped: text(state.proofs.valueScoped),
        proofScoped: text(state.proofs.proofScoped),
        resolved: text(state.certificates),
        selected: text(state.selected),
        touched: [...state.touched].sort(),
        writers: [...state.writers.keys()].sort(),
        admittedLengths: state.admittedLengths === undefined
            ? []
            : [...state.admittedLengths.entries()]
                .map(([name, sequence]) => [name, String(sequence)])
                .sort((left, right) => (left[0] < right[0] ? -1 : (left[0] > right[0] ? 1 : 0))),
        lastNodeIndex: state.lastNodeIndex,
    };
}

describe("synchronizeRetainedJournal, a retained replay state which is not the receiver's", () => {
    test("a state built from a strict prefix of the receiver is refused", () => {
        const receiver = receiverChain();
        const stale = rebuiltStateOf(receiver.slice(0, 2));

        const result = synchronize({
            receiver,
            source: [],
            authorityPhysical: 700,
            retainedState: stale,
        });

        expect("outcome" in result).toBe(false);
        if ("outcome" in result) {
            return;
        }
        expect(result.error.message).toContain("does not describe the receiver's retained journal");
        expect(result.error.message).toContain(WRITER_LOCAL);
        expect(result.error.message).toContain("rebuild/maintenance");
    });

    test("a state which has never seen any retained record is refused", () => {
        const receiver = receiverChain();
        const stale = rebuiltStateOf([]);

        const result = synchronize({
            receiver,
            source: [],
            authorityPhysical: 700,
            retainedState: stale,
        });

        expect("outcome" in result).toBe(false);
    });

    test("a state which has seen a longer prefix than the receiver retains is refused", () => {
        const receiver = receiverChain();
        const stale = rebuiltStateOf([...receiver, ...materialize({
            writer: WRITER_LOCAL,
            sequence: "5",
            node: NODE_D,
            context: [],
            basis: [],
        })]);

        const result = synchronize({
            receiver,
            source: [],
            authorityPhysical: 700,
            retainedState: stale,
        });

        expect("outcome" in result).toBe(false);
    });

    test("success means the retained state is the receiver's own, so no node is omitted", () => {
        const receiver = receiverChain();
        const correct = rebuiltStateOf(receiver);

        const result = synchronize({
            receiver,
            source: [],
            authorityPhysical: 700,
            retainedState: correct,
        });

        expect("outcome" in result).toBe(true);
        if (!("outcome" in result)) {
            return;
        }
        expect(result.outcome.projection.occurrences.map((occurrence) => occurrence.nodeKeyString))
            .toEqual([KEY_A, KEY_B]);
    });
});

/**
 * A value-scoped invalidation of one occurrence, as the writer which emitted it
 * retained it.
 *
 * @param {object} occurrence
 * @param {string} occurrence.writer
 * @param {string} occurrence.sequence
 * @param {import("../src/generators/incremental_graph/journal").NodeKey} occurrence.node
 * @param {ReadonlyArray<string>} occurrence.context
 * @param {string} occurrence.value - The occurrence being invalidated.
 */
function invalidateOccurrence(occurrence) {
    return made(makeInvalidateEvent(
        {
            id: occurrence.writer + ":" + occurrence.sequence,
            context: contextOf([...occurrence.context]),
            authorityTime: authorityOf(Number(occurrence.sequence)),
            node: occurrence.node,
        },
        makeValueScope(occurrence.value),
        "propagated"
    ));
}

describe("synchronizeRetainedJournal, a failed operation's effect on the caller's state", () => {
    test("a value-scoped barrier of the caller's state is unchanged when the operation fails", () => {
        // The receiver already holds a value-scoped invalidation of its own `A`
        // occurrence, so its counted summary has the whole `node -> valueId ->
        // coordinate maximum` chain an imported invalidation is admitted into. The
        // peer invalidates that same occurrence under its own writer, which is
        // therefore admitted into the fork's value-scoped maximum for the caller's
        // own scope. If the fork shared that maximum with the caller, the failed
        // operation would leave the caller's barrier naming a record of the peer,
        // which `retained.js` documents as a coordinate maximum of the admitted
        // invalidations.
        const receiver = [
            ...receiverChain(),
            invalidateOccurrence({
                writer: WRITER_LOCAL,
                sequence: "5",
                node: NODE_A,
                context: [],
                value: WRITER_LOCAL + ":1",
            }),
        ];
        const conflicting = [
            ...materialize({
                writer: WRITER_PEER,
                sequence: "1",
                node: NODE_D,
                context: [[WRITER_LOCAL, "4"]],
                basis: [],
                identifier: identifierOf(KEY_A),
            }),
            invalidateOccurrence({
                writer: WRITER_PEER,
                sequence: "3",
                node: NODE_A,
                context: [[WRITER_PEER, "2"], [WRITER_LOCAL, "4"]],
                value: WRITER_LOCAL + ":1",
            }),
        ];
        const state = rebuiltStateOf(receiver);
        const before = stateSnapshot(state);
        expect(before.valueScoped).toEqual([
            [KEY_A, [[WRITER_LOCAL + ":1", [[WRITER_LOCAL, "5"]]]]],
        ]);

        const result = synchronize({
            receiver,
            source: conflicting,
            authorityPhysical: 700,
            retainedState: state,
        });

        expect("outcome" in result).toBe(false);
        if ("outcome" in result) {
            return;
        }
        expect(result.error.message).toContain("same physical node identifier");
        expect(stateSnapshot(state)).toEqual(before);
    });

    test("a state is unchanged when the operation fails while projecting", () => {
        // The peer materializes the unrelated leaf `D` under the physical identifier
        // the receiver's own `A` already holds, so the cut fails on
        // `validateNodeIdentifierDistinctness` after the import has been staged.
        const receiver = receiverChain();
        const conflicting = materialize({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_D,
            context: [[WRITER_LOCAL, "4"]],
            basis: [],
            identifier: identifierOf(KEY_A),
        });
        const state = rebuiltStateOf(receiver);
        const before = stateSnapshot(state);

        const result = synchronize({
            receiver,
            source: conflicting,
            authorityPhysical: 700,
            retainedState: state,
        });

        expect("outcome" in result).toBe(false);
        if ("outcome" in result) {
            return;
        }
        expect(result.error.message).toContain("same physical node identifier");
        expect(stateSnapshot(state)).toEqual(before);
    });

    test("the state a failed operation left behind still describes the receiver", () => {
        const receiver = receiverChain();
        const conflicting = materialize({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_D,
            context: [[WRITER_LOCAL, "4"]],
            basis: [],
            identifier: identifierOf(KEY_A),
        });
        const state = rebuiltStateOf(receiver);

        synchronize({
            receiver,
            source: conflicting,
            authorityPhysical: 700,
            retainedState: state,
        });

        // The same state, handed to a synchronization which has nothing to do, still
        // projects the receiver's own journal rather than the failed operation's
        // partially staged one.
        const after = synchronize({
            receiver,
            source: [],
            authorityPhysical: 700,
            retainedState: state,
        });

        expect("outcome" in after).toBe(true);
        if (!("outcome" in after)) {
            return;
        }
        expect(after.outcome.projection.occurrences.map((occurrence) => occurrence.nodeKeyString))
            .toEqual([KEY_A, KEY_B]);
    });

    test("a successful operation does reach the caller's own state", () => {
        const receiver = receiverChain();
        const peerAddsD = materialize({
            writer: WRITER_PEER,
            sequence: "1",
            node: NODE_D,
            context: [[WRITER_LOCAL, "4"]],
            basis: [],
        });
        const state = rebuiltStateOf(receiver);

        const result = synchronize({
            receiver,
            source: peerAddsD,
            authorityPhysical: 700,
            retainedState: state,
        });

        expect("outcome" in result).toBe(true);
        if (!("outcome" in result)) {
            return;
        }
        expect(result.outcome.retainedState).toBe(state);
        expect(stateSnapshot(state).heads.map(([nodeKeyString]) => nodeKeyString))
            .toEqual([KEY_A, KEY_B, KEY_D]);
    });
});
