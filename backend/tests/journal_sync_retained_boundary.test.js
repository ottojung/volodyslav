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
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeJournalSequence,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
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
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const WRITER_LOCAL = "aaaaaaaaa";
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
