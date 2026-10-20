/**
 * Synchronization makes an input-caused staleness durable, and a later upstream
 * `Unchanged` freshens only the upstream node.
 *
 * `incremental-graph-journal-testing.md` §Synchronization fixed-point and
 * stale-persistence tests pins the critical regression:
 *
 * ```text
 * A -> B
 * common: A=a1 fresh
 * source Y: B=b2 fresh, validated against A=a1
 * receiver X: A=a1 stale
 * ```
 *
 * After sync B=b2 is persistently stale. Later `A -> Unchanged` may freshen A
 * but not B until B validates/recomputes.
 *
 * `incremental-graph-journal-sync.md` §Phase 2 requires the sync marker which
 * makes that staleness durable: an occurrence which is self-proof-ready and
 * stale solely through a stale direct input must carry an uncovered value-scoped
 * `reason: "sync"` invalidation, so the staleness survives the input's later
 * freshening instead of silently disappearing with it.
 */

const {
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceToString,
    makeAuthorityTime,
    makeInvalidateEvent,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeJournalSequence,
    makeNodeScope,
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
    SnapshotIdentityClass,
    synchronizeRetainedJournal,
} = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
    isRetainedReplayState,
} = require("../src/generators/incremental_graph/journal_retained");

const NODE_A = { head: "event", args: [{ id: 1 }] };
const NODE_B = { head: "event", args: [{ id: 2 }] };
const KEY_A = nodeKeyToCanonicalString(NODE_A);
const KEY_B = nodeKeyToCanonicalString(NODE_B);
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const PAYLOAD = { type: "entry_description", description: "x" };
const INSTANT = 1700000000000;

/**
 * The schema of the critical regression: `A -> B`, with `A` a leaf. A node with
 * no entry is a node with no direct input, which is what makes `A` the node the
 * freshness recursion bottoms out on.
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function schema(nodeKeyString) {
    return nodeKeyString === KEY_B ? [KEY_A] : [];
}

/**
 * @param {ReadonlyArray<string>} coordinates
 * @returns {import("../src/generators/incremental_graph/journal").JournalFrontier}
 */
function contextOf(coordinates) {
    return makeJournalFrontierFromText(coordinates);
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
 * @param {string} nodeKeyString
 * @returns {string}
 */
function identifierOf(nodeKeyString) {
    return JSON.parse(nodeKeyString).args[0].id + "-abcdefghi";
}

/**
 * Assert that a synchronization succeeded, reporting the failure it produced.
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
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {import("../src/generators/incremental_graph/journal").JournalReplica}
 */
function replicaOf(records) {
    /** @type {Map<string, Array<import("../src/generators/incremental_graph/journal").JournalRecord>>} */
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
            last === undefined ? [] : [[WRITER_LOCAL, journalSequenceToString(last.id.sequence)]]
        ),
        authorityHighWater: authorityOf(authorityPhysical),
        allocatorWatermark: 0,
    };
}

/**
 * The activated replica's retained replay state for a receiver's retained journal.
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} receiver
 * @returns {Promise<import("../src/generators/incremental_graph/journal_retained").RetainedReplayState>}
 */
async function retainedStateOf(receiver) {
    const built = await buildRetainedReplayState({
        source: makeReplicaSource(replicaOf(receiver)),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        currentInputKeysOfNode: schema,
    });
    if ("error" in built) {
        throw new Error("the receiver's retained state could not be built: " + built.error.message);
    }
    expect(isRetainedReplayState(built.state)).toBe(true);
    return built.state;
}

/**
 * The common prefix of the critical regression: the peer's `A=a1`, materialized
 * and validated, so `A` is fresh on both sides.
 * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
 */
function commonPrefix() {
    return [
        made(makeValueEvent(
            {
                id: WRITER_PEER + ":1",
                context: contextOf([]),
                authorityTime: authorityOf(10),
                node: NODE_A,
            },
            identifierOf(KEY_A),
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        )),
        made(makeValidateEvent(
            {
                id: WRITER_PEER + ":2",
                context: contextOf([[WRITER_PEER, "1"]]),
                authorityTime: authorityOf(12),
                node: NODE_A,
            },
            WRITER_PEER + ":1",
            [],
            "compute"
        )),
    ];
}

/**
 * Source `Y`: the common prefix plus the peer's `B=b2`, materialized and
 * validated against `A=a1`, so `B` is fresh on the source.
 * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
 */
function sourceRecords() {
    return [
        ...commonPrefix(),
        made(makeValueEvent(
            {
                id: WRITER_PEER + ":3",
                context: contextOf([[WRITER_PEER, "2"]]),
                authorityTime: authorityOf(14),
                node: NODE_B,
            },
            identifierOf(KEY_B),
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        )),
        made(makeValidateEvent(
            {
                id: WRITER_PEER + ":4",
                context: contextOf([[WRITER_PEER, "3"]]),
                authorityTime: authorityOf(16),
                node: NODE_B,
            },
            WRITER_PEER + ":3",
            [makeValidationBasisEntry(NODE_A, WRITER_PEER + ":1")],
            "compute"
        )),
    ];
}

/**
 * Receiver `X`: the common prefix plus the receiver's own node-scoped
 * invalidation of `A`, which is what makes the retained `A=a1` stale on the
 * receiver alone.
 * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
 */
function receiverRecords() {
    return [
        ...commonPrefix(),
        made(makeInvalidateEvent(
            {
                id: WRITER_LOCAL + ":1",
                context: contextOf([]),
                authorityTime: authorityOf(100),
                node: NODE_A,
            },
            makeNodeScope(),
            "explicit"
        )),
    ];
}

/**
 * @param {object} options
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} options.receiver
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} options.source
 * @param {number} options.authorityPhysical
 * @returns {Promise<import("../src/generators/incremental_graph/journal_sync").SyncOutcome>}
 */
async function synchronize(options) {
    const result = await synchronizeRetainedJournal({
        receiver: makeReplicaSource(replicaOf(options.receiver)),
        source: makeReplicaSource(replicaOf(options.source)),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        committed: committedAfter(options.receiver, options.authorityPhysical),
        observedHighWater: authorityOf(options.authorityPhysical),
        publicationInstant: INSTANT,
        currentInputKeysOfNode: schema,
        receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
        sourceIdentity: new SnapshotIdentityClass("v1", "scheme"),
        retainedState: await retainedStateOf(options.receiver),
    });
    return await withCollectedRecords(result);
}

/**
 * The later `A -> Unchanged`: the receiver's own writer revalidates `A` and
 * proves the occurrence the projection already selected, causally observing
 * both its own invalidation and the `A=a1` occurrence it certifies.
 * @param {import("../src/generators/incremental_graph/journal_sync").SyncOutcome} outcome
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
 */
function laterUpstreamUnchanged(outcome) {
    const head = Number(journalSequenceToString(outcome.publication.writerState.writerHead));
    return made(makeValidateEvent(
        {
            id: WRITER_LOCAL + ":" + String(head + 1),
            context: contextOf([[WRITER_LOCAL, String(head)], [WRITER_PEER, "1"]]),
            authorityTime: authorityOf(900),
            node: NODE_A,
        },
        WRITER_PEER + ":1",
        [],
        "unchanged"
    ));
}

/**
 * Project a committed journal the way the next routine replay would.
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {Promise<import("../src/generators/incremental_graph/journal").Projection>}
 */
async function project(records) {
    const projected = await projectRetainedJournal({
        source: makeReplicaSource(replicaOf(records)),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        currentInputKeysOfNode: schema,
    });
    if (projected instanceof Error) {
        throw new Error("the committed journal does not project: " + projected.message);
    }
    return projected;
}

/**
 * @param {import("../src/generators/incremental_graph/journal").Projection} projection
 * @returns {Map<string, import("../src/generators/incremental_graph/journal").Occurrence>}
 */
function byKeyOf(projection) {
    return new Map(
        projection.occurrences.map((occurrence) => [occurrence.nodeKeyString, occurrence])
    );
}

describe("synchronization persists an input-caused staleness through a later upstream freshening", () => {
    test("an imported occurrence validated against a stale input is persistently stale after sync", async () => {
        const outcome = outcomeOf(await synchronize({
            receiver: receiverRecords(),
            source: sourceRecords(),
            authorityPhysical: 500,
        }));

        // `A` is stale on its own account through the retained node invalidation;
        // `B=b2` is self-proof-ready and stale only because its input is stale.
        const byKey = byKeyOf(outcome.projection);
        expect(byKey.get(KEY_A).fresh).toBe(false);
        expect(byKey.get(KEY_B).fresh).toBe(false);

        // The persistence mechanism `incremental-graph-journal-sync.md` §Phase 2
        // requires: an uncovered value-scoped `reason: "sync"` marker naming the
        // selected occurrence, so the staleness outlives the input's freshening.
        const markers = outcome.publication.records.filter(
            (record) => record.kind === "invalidate" && record.scope.kind === "value"
        );
        expect(markers).toHaveLength(1);
        expect(nodeKeyToCanonicalString(markers[0].node)).toBe(KEY_B);
        expect(journalRecordIdToString(markers[0].scope.value)).toBe(WRITER_PEER + ":3");
        expect(markers[0].reason).toBe("sync");
    });

    test("a later upstream Unchanged freshens the input but not the imported dependent", async () => {
        const receiver = receiverRecords();
        const outcome = outcomeOf(await synchronize({
            receiver,
            source: sourceRecords(),
            authorityPhysical: 500,
        }));

        const afterUpstream = await project([...receiver, ...outcome.records, laterUpstreamUnchanged(outcome)]);
        const byKey = byKeyOf(afterUpstream);
        expect(byKey.get(KEY_A).fresh).toBe(true);
        expect(byKey.get(KEY_B).fresh).toBe(false);
    });
});
