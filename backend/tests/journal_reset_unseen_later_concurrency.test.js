/**
 * `incremental-graph-journal-reset.md` §Reset history and future synchronization.
 *
 * The normative sentence is:
 *
 * > An unseen concurrent event from another replica remains concurrent and may affect a
 * > later ordinary synchronization.
 *
 * and its surrounding paragraph:
 *
 * > Reset-authored records are causally after all history reset observed, so they
 * > establish the requested target relative to that observed history. ... Reset
 * > therefore means: establish this source projection relative to all history currently
 * > observed — not: permanently dominate every event that might exist elsewhere.
 *
 * `incremental-graph-journal-testing.md` §Reset tests lists "unseen later concurrency"
 * among the generated reset tests; no other test drives a reset and then an ordinary
 * synchronization of an event the reset never observed.
 *
 * These tests exercise that exact sequence through the production algorithms, with no
 * test-local reimplementation of either one:
 *
 * 1. `resetToSource` — the production reset, the whole algorithm up to the publication
 *    write — establishes a source target whose occurrence differs from the receiver's,
 *    so reset authors a replacement `ValueEvent` (and its proof) under the receiver's
 *    own writer.
 * 2. A third writer `Z` authors an occurrence of the same node whose context observes
 *    only `Z`'s own prefix, so `Z` is concurrent with every record reset observed and
 *    with every record reset authored. `Z` was never part of the reset source.
 * 3. `synchronizeRetainedJournal` — the production synchronization, the whole algorithm
 *    up to the publication write, and the algorithm the shipped
 *    `syncJournalReceiverToSource` calls — imports `Z`'s suffix into the post-reset
 *    retained journal.
 *
 * The observable consequences the specification requires:
 *
 * - `Z`'s records are admitted as ordinary retained history;
 * - the committed projection is the reference replay of the union of the post-reset
 *   journal and `Z`'s suffix (`incremental-graph-journal-testing.md` §Reference replay
 *   oracle), so reset did not permanently dominate an event it never saw; and
 * - because `Z`'s occurrence has strictly greater authority than the reset-authored one,
 *   ordinary authority selects `Z`, so the unseen event demonstrably *affects* the later
 *   synchronization rather than being suppressed by the reset.
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
    makeValueEvent,
    nodeKeyToCanonicalString,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal");

const { withCollectedRecords } = require("./journal_record_growth_helper");

const {
    SnapshotIdentityClass,
    synchronizeRetainedJournal,
} = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
    isResetOutcome,
    makeResetSource,
    resetToSource,
} = require("../src/generators/incremental_graph/journal_reset");

const NODE_K = { head: "event", args: [{ id: 1 }] };
const KEY_K = nodeKeyToCanonicalString(NODE_K);
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const WRITER_Z = "ccccccccc";
const LOCAL_AUTHOR = makeJournalAuthor(WRITER_LOCAL);
const PEER_AUTHOR = makeJournalAuthor(WRITER_PEER);
const RECEIVER_PAYLOAD = { type: "entry_description", description: "receiver" };
const SOURCE_PAYLOAD = { type: "entry_description", description: "source" };
const UNSEEN_PAYLOAD = { type: "entry_description", description: "unseen" };
const INSTANT = 1700000000000;
/** Strictly greater than any authority a reset seeded from `INSTANT` can author. */
const UNSEEN_AUTHORITY = INSTANT + 5000;

/**
 * The node has no direct inputs, so the reset target and the later synchronization both
 * operate on a single occurrence and every proof barrier reset can author is vacuous.
 * That keeps the fixture about concurrency, not about dependency closure.
 *
 * @returns {ReadonlyArray<string>}
 */
function leafSchema() {
    return [];
}

/**
 * @param {ReadonlyArray<string>} coordinates
 */
function contextOf(coordinates) {
    return makeJournalFrontierFromText(coordinates);
}

/**
 * The coordinates a writer's record at `sequence` observed: what the caller said it had
 * seen, plus the writer's own complete already-committed prefix.
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
 * @param {string} nodeKeyString
 */
function identifierOf(nodeKeyString) {
    return JSON.parse(nodeKeyString).args[0].id + "-abcdefghi";
}

/**
 * One materialization of `NODE_K`.
 *
 * @param {object} occurrence
 * @param {string} occurrence.writer
 * @param {string} occurrence.sequence
 * @param {ReadonlyArray<string>} occurrence.context
 * @param {number} occurrence.authority
 * @param {object} occurrence.payload
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
 */
function materialize(occurrence) {
    return made(makeValueEvent(
        {
            id: occurrence.writer + ":" + occurrence.sequence,
            context: contextOf(observedUpTo(occurrence.writer, occurrence.sequence, occurrence.context)),
            authorityTime: authorityOf(occurrence.authority),
            node: NODE_K,
        },
        identifierOf(KEY_K),
        occurrence.payload,
        NOW,
        LATER,
        "compute"
    ));
}

/**
 * The validation of the occurrence this same writer materialized one coordinate earlier,
 * against the exact current direct inputs of the leaf (none).
 *
 * @param {object} validation
 * @param {string} validation.writer
 * @param {string} validation.valueSequence
 * @param {ReadonlyArray<string>} validation.context
 * @param {number} validation.authority
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
 */
function validateOwn(validation) {
    const sequence = String(Number(validation.valueSequence) + 1);
    return made(makeValidateEvent(
        {
            id: validation.writer + ":" + sequence,
            context: contextOf(observedUpTo(validation.writer, sequence, validation.context)),
            authorityTime: authorityOf(validation.authority),
            node: NODE_K,
        },
        validation.writer + ":" + validation.valueSequence,
        [],
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
 * The held source snapshot: one cut's version, scheme, retained history and committed
 * projection together.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 */
async function sourceSnapshotOf(records) {
    const journal = makeReplicaSource(replicaOf(records));
    const projection = await projectRetainedJournal({
        source: journal,
        localWriter: PEER_AUTHOR,
        currentInputKeysOfNode: leafSchema,
    });
    if (projection instanceof Error) {
        throw new Error("the source fixture does not project: " + projection.message);
    }
    return makeResetSource({
        databaseVersion: "v1",
        graphSchemeString: "scheme",
        journal,
        projection,
    });
}

/**
 * The retained replay state the activated replica maintains, as the persistence front
 * loads it before a reset. Building it here is the maintenance traversal the storage
 * specification permits for a missing derived index; reset itself refuses a receiver
 * which does not hold the state.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {Promise<import("../src/generators/incremental_graph/journal_reset").RetainedReplayState>}
 */
async function retainedStateOf(records) {
    const built = await buildRetainedReplayState({
        source: makeReplicaSource(replicaOf(records)),
        localWriter: LOCAL_AUTHOR,
        currentInputKeysOfNode: leafSchema,
    });
    if ("error" in built) {
        throw new Error("the receiver fixture has no retained replay state: " + built.error.message);
    }
    return built.state;
}

/**
 * The receiver and the held source snapshot of the fixture.
 *
 * The receiver's own occurrence carries the greater authority, so the raw union selects
 * the receiver's occurrence and reset must author a replacement occurrence for the
 * source target rather than merely preserving one. That is what makes the reset author
 * records under its own writer at all.
 *
 * @returns {{
 *   receiver: ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>,
 *   source: ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>
 * }}
 */
function receiverAndSource() {
    const receiver = [
        materialize({ writer: WRITER_LOCAL, sequence: "1", context: [], authority: 100, payload: RECEIVER_PAYLOAD }),
        validateOwn({ writer: WRITER_LOCAL, valueSequence: "1", context: [], authority: 101 }),
    ];
    const source = [
        materialize({ writer: WRITER_PEER, sequence: "1", context: [], authority: 90, payload: SOURCE_PAYLOAD }),
        validateOwn({ writer: WRITER_PEER, valueSequence: "1", context: [], authority: 91 }),
    ];
    return { receiver, source };
}

/**
 * The unseen third writer's concurrent occurrence of `NODE_K`, with its own proof.
 *
 * Its context observes only `Z`'s own prefix, so it is causally concurrent with every
 * record reset observed and every record reset authored. Its authority is strictly
 * greater than any authority a reset seeded from `INSTANT` can author, so ordinary
 * authority selects it once the histories meet.
 *
 * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
 */
function unseenConcurrentEvent() {
    return [
        materialize({ writer: WRITER_Z, sequence: "1", context: [], authority: UNSEEN_AUTHORITY, payload: UNSEEN_PAYLOAD }),
        validateOwn({ writer: WRITER_Z, valueSequence: "1", context: [], authority: UNSEEN_AUTHORITY + 1 }),
    ];
}

/**
 * Run the production reset to the held source snapshot.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} receiver
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} source
 * @returns {Promise<import("../src/generators/incremental_graph/journal_reset").ResetOutcome>}
 */
async function reset(receiver, source) {
    const receiverSource = makeReplicaSource(replicaOf(receiver));
    const result = await resetToSource({
        receiver: receiverSource,
        retainedState: await retainedStateOf(receiver),
        source: await sourceSnapshotOf(source),
        localWriter: LOCAL_AUTHOR,
        committed: committedAfter(receiver, 101),
        observedHighWater: authorityOf(101),
        publicationInstant: INSTANT,
        currentInputKeysOfNode: leafSchema,
        receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
    });
    if (!("outcome" in result)) {
        throw new Error("reset failed with " + result.error.name + ": " + result.error.message);
    }
    expect(isResetOutcome(result.outcome)).toBe(true);
    await withCollectedRecords(result);
    return result.outcome;
}

/**
 * Run the production synchronization of a foreign suffix into a retained journal.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} receiver
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} source
 * @param {import("../src/generators/incremental_graph/journal_reset").RetainedReplayState} retainedState
 * @returns {Promise<import("../src/generators/incremental_graph/journal_sync").SyncOutcome>}
 */
async function synchronize(receiver, source, retainedState) {
    const result = await synchronizeRetainedJournal({
        receiver: makeReplicaSource(replicaOf(receiver)),
        source: makeReplicaSource(replicaOf(source)),
        localWriter: LOCAL_AUTHOR,
        committed: committedAfter(receiver, UNSEEN_AUTHORITY + 1),
        observedHighWater: authorityOf(UNSEEN_AUTHORITY + 1),
        publicationInstant: UNSEEN_AUTHORITY + 2,
        currentInputKeysOfNode: leafSchema,
        receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
        sourceIdentity: new SnapshotIdentityClass("v1", "scheme"),
        retainedState,
    });
    if (!("outcome" in result)) {
        throw new Error("synchronization failed with " + result.error.name + ": " + result.error.message);
    }
    await withCollectedRecords(result);
    return result.outcome;
}

/**
 * @param {import("../src/generators/incremental_graph/journal").Projection} projection
 * @returns {string | undefined}
 */
function selectedValueIdOf(projection) {
    const occurrence = projection.occurrences.find(
        (candidate) => candidate.nodeKeyString === KEY_K
    );
    if (occurrence === undefined) {
        return undefined;
    }
    return journalRecordIdToString(occurrence.valueId);
}

/**
 * @param {import("../src/generators/incremental_graph/journal").Projection} projection
 * @returns {unknown}
 */
function selectedPayloadOf(projection) {
    const occurrence = projection.occurrences.find(
        (candidate) => candidate.nodeKeyString === KEY_K
    );
    return occurrence === undefined ? undefined : occurrence.payload;
}

describe("reset, then an unseen concurrent event reaches an ordinary synchronization", () => {
    test("the unseen event is admitted and ordinary authority selects it over the reset target", async () => {
        const { receiver, source } = receiverAndSource();
        const resetOutcome = await reset(receiver, source);

        // The reset established the source target: the receiver's occurrence was replaced
        // by a reset-authored one carrying the source payload.
        const resetAuthored = resetOutcome.publication.records.filter(
            (record) => record.kind === "value"
        );
        expect(resetAuthored).toHaveLength(1);
        expect(resetAuthored[0].reason).toBe("reset");
        expect(resetAuthored[0].payload).toEqual(SOURCE_PAYLOAD);
        expect(selectedPayloadOf(resetOutcome.projection)).toEqual(SOURCE_PAYLOAD);

        const postReset = [...receiver, ...resetOutcome.records];
        const unseen = unseenConcurrentEvent();
        const syncOutcome = await synchronize(postReset, unseen, resetOutcome.retainedState);

        // The unseen writer's records are admitted as ordinary retained history.
        expect(syncOutcome.records.map((record) => journalRecordIdToString(record.id))).toEqual([
            WRITER_Z + ":1",
            WRITER_Z + ":2",
        ]);
        expect(syncOutcome.records.every(
            (record) => journalAuthorToString(record.id.author) === WRITER_Z
        )).toBe(true);

        // Ordinary authority, not the reset, decides the winner: the unseen occurrence has
        // greater authority and replaces the reset-established one. The reset did not
        // permanently dominate an event it never observed.
        expect(selectedValueIdOf(syncOutcome.projection)).toBe(WRITER_Z + ":1");
        expect(selectedPayloadOf(syncOutcome.projection)).toEqual(UNSEEN_PAYLOAD);
        expect(syncOutcome.projection.occurrences.every((occurrence) => occurrence.fresh)).toBe(true);
    });

    test("the synchronized projection is the reference replay of the post-reset union", async () => {
        const { receiver, source } = receiverAndSource();
        const resetOutcome = await reset(receiver, source);

        const postReset = [...receiver, ...resetOutcome.records];
        const unseen = unseenConcurrentEvent();
        const syncOutcome = await synchronize(postReset, unseen, resetOutcome.retainedState);

        const reference = await projectRetainedJournal({
            source: makeReplicaSource(replicaOf([...postReset, ...unseen])),
            localWriter: LOCAL_AUTHOR,
            currentInputKeysOfNode: leafSchema,
        });
        expect(reference instanceof Error).toBe(false);
        expect(syncOutcome.projection).toEqual(reference);
    });

    test("a second synchronization against the same unseen suffix authors nothing", async () => {
        const { receiver, source } = receiverAndSource();
        const resetOutcome = await reset(receiver, source);

        const postReset = [...receiver, ...resetOutcome.records];
        const unseen = unseenConcurrentEvent();
        const first = await synchronize(postReset, unseen, resetOutcome.retainedState);

        const afterFirst = [...postReset, ...first.records];
        const second = await synchronize(
            afterFirst,
            unseen,
            await retainedStateOf(afterFirst)
        );

        expect(second.records).toEqual([]);
        expect(selectedValueIdOf(second.projection)).toBe(WRITER_Z + ":1");
    });
});
