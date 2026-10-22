/**
 * Synchronization normalization over a dependency/staleness closure larger than
 * the in-memory work-queue threshold.
 *
 * `incremental-graph-journal-testing.md` §Streaming correctness (L888) requires a
 * test which "synchronize[s] a foreign suffix and dependency/staleness closure
 * larger than the in-memory work-queue threshold; require[s] an
 * iterator/durable-index-backed normalization path and the same final
 * Journal/projection as the reference model".
 *
 * The normative source is `incremental-graph-journal-sync.md` §Streamability
 * (L303-311): the dependency-removal closure, the stale-propagation worklist and
 * the complete changed-node set are Journal-derived work which "must be
 * incrementally iterable" and "MUST NOT require the complete closure/change set
 * to exist as one in-RAM collection", while graph-sized derived graph/index state
 * that IncrementalGraph correctness independently requires is permitted. The
 * implementation checklist §10 states the same obligation, and `$id-4924739474925738`
 * (`docs/intent-records/synchronization-performance.md`) is the underlying intent.
 *
 * ## What is exercised
 *
 * The subject is the real production algorithm `synchronizeRetainedJournal`, the
 * same whole algorithm `syncJournalReceiverToSource` calls, driven end to end
 * against supported graph plus Journal pairs. Two shapes make the normalization
 * worklist graph-sized, far larger than `WORK_QUEUE_THRESHOLD`:
 *
 * - a foreign `DeleteEvent` for the root of a long chain, whose union leaves every
 *   descendant structurally non-materializable, so Phase 1's dependency-removal
 *   closure is the whole tail; and
 * - a foreign materialization appended to a chain whose root is unproven, so
 *   Phase 2's stale-propagation closure is the whole tail plus the imported node.
 *
 * For each, the final `outcome.projection` is compared against the **reference
 * model**: a full independent replay of the final Journal through
 * `projectRetainedJournal`. A normalization which folded the closure by rescanning
 * retained history, dropped a dependent, or mis-ordered cause before dependent
 * would diverge from that replay.
 *
 * ## What "iterator/durable-index-backed" is pinned by
 *
 * The normalization derives its closure from the maintained retained head index
 * (`selectedHeadsOf`) and the maintained projection, not by re-reading retained
 * Value/Delete records: the end-to-end cases compare against the reference replay
 * (a path that does read the whole history) rather than re-deriving the closure
 * from it, and the last case pins that the dependency-removal worklist builds its
 * reverse dependent index once and reuses it, so the schema is consulted
 * `O(present nodes)` rather than `O(closure x present nodes)`. The receiver's
 * retained record read shape across synchronization is pinned independently by
 * `journal_sync_retained_state.test.js`.
 *
 * Every fixture is a supported graph plus Journal pair in the sense of
 * `incremental-graph-journal-testing.md` §Reference replay oracle: each node is
 * materialized and then validated against the exact current direct-input
 * occurrences it observed.
 */

const {
    HeadSelectionClass,
    journalAuthorToString,
    makeAuthorityTime,
    makeDeleteEvent,
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

const { withCollectedRecords } = require("./journal_record_growth_helper");

const {
    isSyncOutcome,
    planDependencyClosureRemoval,
    SnapshotIdentityClass,
    synchronizeRetainedJournal,
} = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
} = require("../src/generators/incremental_graph/journal_retained");

const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const PAYLOAD = { type: "entry_description", description: "x" };
const INSTANT = 1700000000000;

/**
 * The test's stand-in for the implementation's in-memory work-queue threshold.
 *
 * The specification does not fix a numeric threshold; the point is that the
 * closure processed below is far larger than any small bounded buffer a
 * non-streaming implementation would keep, so a worklist which had to hold the
 * complete closure as one collection would have to exceed it.
 */
const WORK_QUEUE_THRESHOLD = 16;

/**
 * The chain length, chosen to be many multiples of the threshold so the closure
 * is unambiguously larger than the work queue.
 */
const CHAIN_LENGTH = 64;

/**
 * The receiver's chain occupies ids `0 .. CHAIN_LENGTH - 1`; the foreign peer
 * appends the node with id `CHAIN_LENGTH`.
 */
const FOREIGN_ID = CHAIN_LENGTH;

const PEER_DELETE_AUTHORITY = 100000;
const PEER_VALUE_AUTHORITY = 110000;
const COMMITTED_HIGH_WATER = 200000;

/**
 * @param {number} count
 * @returns {ReadonlyArray<number>}
 */
function range(count) {
    return Array.from({ length: count }, (_, index) => index);
}

/**
 * @param {number} id
 * @returns {import("../src/generators/incremental_graph/journal").NodeKey}
 */
function nodeOf(id) {
    return { head: "event", args: [{ id }] };
}

/**
 * @param {number} id
 * @returns {string}
 */
function keyOf(id) {
    return nodeKeyToCanonicalString(nodeOf(id));
}

/**
 * @param {number} id
 * @returns {string}
 */
function identifierOf(id) {
    return id + "-abcdefghi";
}

/**
 * The chain schema: node `i` depends on node `i - 1`, and node `0` is a leaf.
 * Defined through the foreign id as well, because the peer appends a node.
 *
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function chainInputs(nodeKeyString) {
    for (const id of range(FOREIGN_ID + 1)) {
        if (keyOf(id) === nodeKeyString) {
            return id === 0 ? [] : [keyOf(id - 1)];
        }
    }
    return [];
}

/**
 * @param {number} physical
 * @returns {import("../src/generators/incremental_graph/journal").AuthorityTime}
 */
function authorityOf(physical) {
    return makeAuthorityTime(physical, "0");
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
 * A chain of materializations and (optionally) validations by one writer, with
 * contiguous own-writer coordinates and exact own-prefix contexts.
 *
 * Node `0` is the chain leaf; every later node's validation names its
 * predecessor's value occurrence as its one basis input, which is the current
 * canonical shape of the node. A node not in `proven` is materialized without a
 * validation, so it is stale on its own account rather than through its inputs.
 *
 * @param {ReadonlyArray<number>} ids
 * @param {ReadonlySet<number>} proven
 * @returns {{records: import("../src/generators/incremental_graph/journal").JournalRecord[], valueSequenceOf: Map<number, number>, head: number}}
 */
function buildLocalChain(ids, proven) {
    /** @type {import("../src/generators/incremental_graph/journal").JournalRecord[]} */
    const records = [];
    /** @type {Map<number, number>} */
    const valueSequenceOf = new Map();
    let sequence = 0;
    /** @type {{id: number, valueSequence: number} | undefined} */
    let previous;
    for (const id of ids) {
        sequence += 1;
        const valueSequence = sequence;
        const valueId = WRITER_LOCAL + ":" + String(valueSequence);
        const valueContext = sequence === 1
            ? []
            : [[WRITER_LOCAL, String(sequence - 1)]];
        records.push(made(makeValueEvent(
            {
                id: valueId,
                context: makeJournalFrontierFromText(valueContext),
                authorityTime: authorityOf(sequence),
                node: nodeOf(id),
            },
            identifierOf(id),
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        )));
        valueSequenceOf.set(id, valueSequence);
        if (proven.has(id)) {
            sequence += 1;
            const validateSequence = sequence;
            const basis = previous === undefined
                ? []
                : [makeValidationBasisEntry(
                    nodeOf(previous.id),
                    WRITER_LOCAL + ":" + String(previous.valueSequence)
                )];
            records.push(made(makeValidateEvent(
                {
                    id: WRITER_LOCAL + ":" + String(validateSequence),
                    context: makeJournalFrontierFromText([
                        [WRITER_LOCAL, String(sequence - 1)],
                    ]),
                    authorityTime: authorityOf(validateSequence),
                    node: nodeOf(id),
                },
                valueId,
                basis,
                "compute"
            )));
        }
        previous = { id, valueSequence };
    }
    return { records, valueSequenceOf, head: sequence };
}

/**
 * A peer deletion of one node, observing the receiver's complete own prefix.
 *
 * @param {number} id
 * @param {number} receiverHead
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
 */
function peerDeletesNode(id, receiverHead) {
    return made(makeDeleteEvent(
        {
            id: WRITER_PEER + ":1",
            context: makeJournalFrontierFromText([[WRITER_LOCAL, String(receiverHead)]]),
            authorityTime: authorityOf(PEER_DELETE_AUTHORITY),
            node: nodeOf(id),
        },
        "operation"
    ));
}

/**
 * A peer materialization-and-validation of the foreign node, observing the
 * receiver's complete own prefix and validating against its predecessor's value.
 *
 * @param {number} id
 * @param {number} predecessorValueSequence
 * @param {number} receiverHead
 * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
 */
function peerMaterializesNode(id, predecessorValueSequence, receiverHead) {
    const valueId = WRITER_PEER + ":1";
    return [
        made(makeValueEvent(
            {
                id: valueId,
                context: makeJournalFrontierFromText([[WRITER_LOCAL, String(receiverHead)]]),
                authorityTime: authorityOf(PEER_VALUE_AUTHORITY),
                node: nodeOf(id),
            },
            identifierOf(id),
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        )),
        made(makeValidateEvent(
            {
                id: WRITER_PEER + ":2",
                context: makeJournalFrontierFromText([
                    [WRITER_LOCAL, String(receiverHead)],
                    [WRITER_PEER, "1"],
                ]),
                authorityTime: authorityOf(PEER_VALUE_AUTHORITY + 1),
                node: nodeOf(id),
            },
            valueId,
            [makeValidationBasisEntry(
                nodeOf(id - 1),
                WRITER_LOCAL + ":" + String(predecessorValueSequence)
            )],
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
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {import("../src/generators/incremental_graph/journal").CommittedWriterState}
 */
function committedAfter(records) {
    const own = records.filter(
        (record) => journalAuthorToString(record.id.author) === WRITER_LOCAL
    );
    const last = own[own.length - 1];
    return {
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        writerHead: last === undefined
            ? made(makeJournalSequence("0"))
            : last.id.sequence,
        committedFrontier: makeJournalFrontierFromText(
            last === undefined ? [] : [[WRITER_LOCAL, last.id.sequence]]
        ),
        authorityHighWater: authorityOf(COMMITTED_HIGH_WATER),
        allocatorWatermark: 0,
    };
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} receiver
 * @returns {Promise<import("../src/generators/incremental_graph/journal_retained").RetainedReplayState>}
 */
async function retainedStateOf(receiver) {
    const built = await buildRetainedReplayState({
        source: makeReplicaSource(replicaOf(receiver)),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        currentInputKeysOfNode: chainInputs,
    });
    if ("error" in built) {
        throw new Error("the receiver's retained state could not be built: " + built.error.message);
    }
    return built.state;
}

/**
 * @param {object} options
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} options.receiver
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} options.source
 * @returns {Promise<{outcome: import("../src/generators/incremental_graph/journal_sync").SyncOutcome} | {error: import("../src/generators/incremental_graph/journal").JournalError}>}
 */
async function synchronize(options) {
    const identity = new SnapshotIdentityClass("v1", "scheme");
    const result = await synchronizeRetainedJournal({
        receiver: makeReplicaSource(replicaOf(options.receiver)),
        source: makeReplicaSource(replicaOf(options.source)),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        committed: committedAfter(options.receiver),
        observedHighWater: authorityOf(COMMITTED_HIGH_WATER),
        publicationInstant: INSTANT,
        currentInputKeysOfNode: chainInputs,
        receiverIdentity: identity,
        sourceIdentity: identity,
        retainedState: await retainedStateOf(options.receiver),
    });
    return await withCollectedRecords(result);
}

/**
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
 * The reference model: a full independent replay of the final Journal.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {Promise<import("../src/generators/incremental_graph/journal").Projection>}
 */
async function referenceProjection(records) {
    const projected = await projectRetainedJournal({
        source: makeReplicaSource(replicaOf(records)),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        currentInputKeysOfNode: chainInputs,
    });
    if (projected instanceof Error) {
        throw new Error("the reference replay failed: " + projected.message);
    }
    return projected;
}

/**
 * One selected-present head per node, keyed in ascending canonical order, as the
 * raw union's `selectedHeads` view presents it to Phase 1.
 *
 * @param {ReadonlyArray<number>} ids
 * @returns {Map<string, import("../src/generators/incremental_graph/journal").HeadSelection>}
 */
function selectionsOf(ids) {
    /** @type {Map<string, import("../src/generators/incremental_graph/journal").HeadSelection>} */
    const selections = new Map();
    for (const id of [...ids].sort((left, right) => (keyOf(left) < keyOf(right) ? -1 : 1))) {
        const node = nodeOf(id);
        const winner = made(makeValueEvent(
            {
                id: WRITER_LOCAL + ":1",
                context: makeJournalFrontierFromText([]),
                authorityTime: authorityOf(1),
                node,
            },
            identifierOf(id),
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        ));
        selections.set(keyOf(id), new HeadSelectionClass(node, winner));
    }
    return selections;
}

describe("synchronization normalization over a closure larger than the work-queue threshold", () => {
    test("a dependency-removal closure larger than the threshold is published cause before dependent and projects to the reference replay", async () => {
        const ids = range(CHAIN_LENGTH);
        const built = buildLocalChain(ids, new Set(ids));
        const foreign = peerDeletesNode(0, built.head);

        const outcome = outcomeOf(await synchronize({
            receiver: built.records,
            source: [foreign],
        }));

        // The union selects the peer's deletion of the root, so every descendant
        // is structurally non-materializable and the closure is the whole tail,
        // which is many multiples of the threshold.
        const removals = outcome.publication.records.filter((record) => record.kind === "delete");
        expect(removals.length).toBe(CHAIN_LENGTH - 1);
        expect(removals.length).toBeGreaterThan(WORK_QUEUE_THRESHOLD);
        expect(removals.map((record) => nodeKeyToCanonicalString(record.node)))
            .toEqual(ids.slice(1).map(keyOf));
        expect(removals.every((record) => record.reason === "sync")).toBe(true);

        // The final Journal and projection are exactly the reference replay of the
        // post-synchronization union.
        const reference = await referenceProjection([...built.records, ...outcome.records]);
        expect(outcome.projection).toEqual(reference);
        expect(outcome.projection.occurrences).toEqual([]);
    });

    test("a stale-propagation closure larger than the threshold is marked and projects to the reference replay", async () => {
        const ids = range(CHAIN_LENGTH);
        // Node 0 is materialized without a proof, so it is stale on its own
        // account; every proven descendant is self-proof-ready and stale only
        // through its input, which is the Phase 2 worklist.
        const proven = new Set(ids.slice(1));
        const built = buildLocalChain(ids, proven);
        const foreign = peerMaterializesNode(
            FOREIGN_ID,
            built.valueSequenceOf.get(CHAIN_LENGTH - 1) ?? 0,
            built.head
        );

        const outcome = outcomeOf(await synchronize({
            receiver: built.records,
            source: foreign,
        }));

        const markers = outcome.publication.records.filter((record) => record.kind === "invalidate");
        expect(markers.length).toBe(CHAIN_LENGTH);
        expect(markers.length).toBeGreaterThan(WORK_QUEUE_THRESHOLD);
        expect(new Set(markers.map((record) => nodeKeyToCanonicalString(record.node))))
            .toEqual(new Set([...ids.slice(1), FOREIGN_ID].map(keyOf)));
        expect(markers.every((record) => record.reason === "sync")).toBe(true);
        expect(markers.every((record) => record.scope.kind === "value")).toBe(true);

        const reference = await referenceProjection([...built.records, ...outcome.records]);
        expect(outcome.projection).toEqual(reference);
        expect(outcome.projection.unmarkedPropagatedStaleness.size).toBe(0);
    });

    test("the dependency-removal worklist builds its reverse index once, so the schema is consulted once per present node", () => {
        // The root is absent from the raw union, so every descendant is in the
        // closure. A worklist which recomputed each node's inputs while walking the
        // closure would consult the schema once per closure node per present node;
        // an index-backed one consults it once per present node.
        const presentIds = range(CHAIN_LENGTH).slice(1);
        const selections = selectionsOf(presentIds);
        let schemaCalls = 0;
        const countingInputs = (/** @type {string} */ nodeKeyString) => {
            schemaCalls += 1;
            return chainInputs(nodeKeyString);
        };

        const removal = planDependencyClosureRemoval({
            selections,
            currentInputKeysOfNode: countingInputs,
        });

        expect(removal.nodes.length).toBe(CHAIN_LENGTH - 1);
        expect(removal.nodes.length).toBeGreaterThan(WORK_QUEUE_THRESHOLD);
        expect(removal.nodes.map((node) => nodeKeyToCanonicalString(node)))
            .toEqual(presentIds.map(keyOf));
        expect(schemaCalls).toBe(presentIds.length);
    });
});
