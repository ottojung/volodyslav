/**
 * Reset Pass 1 chunked authoring over a production domain larger than the
 * authoring chunk size.
 *
 * `incremental-graph-journal-reset.md` §Streamability requires Pass 1 domain
 * traversal to be implementable as ordered iteration with bounded
 * iterator/runtime buffers, and the implementation authors Pass 1 requests in
 * bounded chunks (`PASS_ONE_CHUNK_SIZE` in `pass1_authoring.js`) so a
 * graph-sized domain never materializes as one request collection. The
 * normative ordering -- every presence authoring before any absence delete --
 * must hold across chunk boundaries, and the whole reset stays atomic because
 * every chunk stages into the fork that is committed only after all passes
 * succeed (`incremental-graph-journal-reset.md` §Atomicity).
 *
 * This test drives the real production algorithm `resetToSource` over a domain
 * of 150 shared leaf nodes plus 5 receiver-only leaves, so Pass 1 must author
 * 150 presence values (more than two full 64-request chunks) followed by 5
 * absence deletes. It pins:
 *
 * - the authored presence population exceeds the chunk size, proving the
 *   chunked path was exercised rather than a single allocation;
 * - every presence record precedes every absence record in publication order;
 * - `outcome.projection` equals the reference model (full independent replay of
 *   the final journal), so no chunk boundary dropped, duplicated, or
 *   mis-ordered a record;
 * - `outcome.valueIds` covers every target-present node.
 *
 * All nodes are leaves validated against no inputs, so Passes 2 and 3 author
 * nothing and the asserted records are exactly Pass 1's.
 */

const {
    journalAuthorToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeReplicaSource,
    makeValueEvent,
    nodeKeyToCanonicalString,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal");

const { withCollectedRecords } = require("./journal_record_growth_helper");

const { SnapshotIdentityClass } = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
    makeResetSource,
    resetToSource,
} = require("../src/generators/incremental_graph/journal_reset");

const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const INSTANT = 1700000000000;
const LOCAL_AUTHOR = makeJournalAuthor(WRITER_LOCAL);

/** More than two full 64-request Pass 1 authoring chunks. */
const SHARED_COUNT = 150;
const RECEIVER_ONLY_COUNT = 5;

/** @returns {ReadonlyArray<string>} */
function noInputs() {
    return [];
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
 * Leaf materializations by one writer with contiguous own-writer coordinates.
 * Every node shares its payload/identifier/timestamps so the only difference
 * between the receiver and the source fixtures is the description below.
 *
 * @param {string} writer
 * @param {number} base - The writer's first authority time.
 * @param {ReadonlyArray<number>} ids
 * @param {(id: number) => string} descriptionOf
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord[]}
 */
function buildLeaves(writer, base, ids, descriptionOf) {
    const records = [];
    let sequence = 0;
    ids.forEach((id, index) => {
        sequence += 1;
        records.push(made(makeValueEvent(
            {
                id: writer + ":" + String(sequence),
                context: makeJournalFrontierFromText(
                    sequence === 1 ? [] : [[writer, String(sequence - 1)]]
                ),
                authorityTime: authorityOf(base + index * 2),
                node: nodeOf(id),
            },
            id + "-abcdefghi",
            { type: "entry_description", description: descriptionOf(id) },
            NOW,
            LATER,
            "compute"
        )));
    });
    return records;
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

describe("reset Pass 1 chunked authoring over a production domain", () => {
    test("authors a multi-chunk presence population before any absence delete and matches the reference replay", async () => {
        const sharedIds = Array.from({ length: SHARED_COUNT }, (_, id) => id);
        const receiverOnlyIds = Array.from(
            { length: RECEIVER_ONLY_COUNT },
            (_, index) => SHARED_COUNT + index
        );
        // The receiver's authority is higher, so the raw union selects the
        // receiver's occurrences; their immutable state differs from the
        // target's, so Pass 1 must re-author every shared node.
        const allReceiverIds = [...sharedIds, ...receiverOnlyIds];
        const receiverRecords = buildLeaves(
            WRITER_LOCAL,
            1000,
            allReceiverIds,
            (id) => (id < SHARED_COUNT ? "receiver" : "receiver-only")
        );
        const sourceRecords = buildLeaves(WRITER_PEER, 10, sharedIds, () => "source");

        const receiver = makeReplicaSource(replicaOf(receiverRecords));
        const built = await buildRetainedReplayState({
            source: receiver,
            localWriter: LOCAL_AUTHOR,
            currentInputKeysOfNode: noInputs,
        });
        if ("error" in built) {
            throw new Error("the receiver fixture has no retained state: " + built.error.message);
        }
        const sourceJournal = makeReplicaSource(replicaOf(sourceRecords));
        const projection = await projectRetainedJournal({
            source: sourceJournal,
            localWriter: LOCAL_AUTHOR,
            currentInputKeysOfNode: noInputs,
        });
        if (projection instanceof Error) {
            throw new Error("the reference replay failed: " + projection.message);
        }
        const source = makeResetSource({
            databaseVersion: "v1",
            graphSchemeString: "scheme",
            journal: sourceJournal,
            projection,
        });
        const lastLocal = receiverRecords
            .filter((record) => journalAuthorToString(record.id.author) === WRITER_LOCAL)
            .slice(-1)[0];
        if (lastLocal === undefined) {
            throw new Error("the receiver fixture has no local record");
        }
        const raw = await resetToSource({
            receiver,
            retainedState: built.state,
            source,
            localWriter: LOCAL_AUTHOR,
            committed: {
                localWriter: LOCAL_AUTHOR,
                writerHead: lastLocal.id.sequence,
                committedFrontier: makeJournalFrontierFromText([[WRITER_LOCAL, lastLocal.id.sequence]]),
                authorityHighWater: authorityOf(500000),
                allocatorWatermark: 0,
            },
            observedHighWater: authorityOf(500000),
            publicationInstant: INSTANT,
            currentInputKeysOfNode: noInputs,
            receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
        });
        const result = await withCollectedRecords(raw);
        if (!("outcome" in result)) {
            throw new Error("reset failed with " + result.error.name + ": " + result.error.message);
        }
        const outcome = result.outcome;

        const values = outcome.publication.records.filter((record) => record.kind === "value");
        const deletes = outcome.publication.records.filter((record) => record.kind === "delete");
        // Every shared node needed re-authoring: strictly more than one full
        // 64-request chunk, so the chunked path was exercised.
        expect(values).toHaveLength(SHARED_COUNT);
        expect(values.length).toBeGreaterThan(64);
        expect(deletes).toHaveLength(RECEIVER_ONLY_COUNT);

        // Presence-before-absence across chunk boundaries.
        const kinds = outcome.publication.records.map((record) => record.kind);
        expect(kinds.slice(0, values.length).every((kind) => kind === "value")).toBe(true);
        expect(kinds.slice(values.length).every((kind) => kind === "delete")).toBe(true);

        // The reset settled every target-present node.
        for (const id of sharedIds) {
            expect(outcome.valueIds.has(keyOf(id))).toBe(true);
        }

        const reference = await projectRetainedJournal({
            source: makeReplicaSource(replicaOf([...receiverRecords, ...outcome.records])),
            localWriter: LOCAL_AUTHOR,
            currentInputKeysOfNode: noInputs,
        });
        if (reference instanceof Error) {
            throw new Error("the reference replay failed: " + reference.message);
        }
        expect(outcome.projection).toEqual(reference);
        expect(outcome.projection.occurrences).toHaveLength(SHARED_COUNT);
    });
});
