/**
 * Production reset regression for bounded Pass 1 authoring.
 *
 * `incremental-graph-journal-reset.md` §Streamability requires Pass 1 domain
 * traversal to be implementable as ordered iteration with bounded buffers, and
 * `pass1_authoring.js` implements that by flushing Pass 1 requests in chunks of
 * 64 (presence first, then absences). This test drives the real production
 * algorithm `resetToSource` over a target whose Pass 1 presence work exceeds
 * that chunk size, and requires the chunked publication to project exactly to
 * the reference replay with one contiguous own-writer range.
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
const PAYLOAD = { type: "entry_description", description: "x" };
const PAYLOAD_SOURCE = { type: "entry_description", description: "y" };
const INSTANT = 1700000000000;
const LOCAL_AUTHOR = makeJournalAuthor(WRITER_LOCAL);

// One more than the Pass 1 chunk size requires at least two allocation
// flushes when every target node must be authored.
const NODE_COUNT = 66;

/**
 * @param {number} id
 * @returns {import("../src/generators/incremental_graph/journal").NodeKey}
 */
function nodeOf(id) {
    return { head: "event", args: [{ id }] };
}

/**
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function chainInputs(nodeKeyString) {
    for (let id = 0; id < NODE_COUNT; id += 1) {
        if (nodeKeyToCanonicalString(nodeOf(id)) === nodeKeyString) {
            return id === 0 ? [] : [nodeKeyToCanonicalString(nodeOf(id - 1))];
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
 * A chain of materializations by one writer with contiguous own-writer
 * coordinates and exact own-prefix contexts. No node is validated, so Pass 2
 * has no eligible proof edges and Pass 3 has no stale propagation: the reset
 * under test exercises Pass 1 presence authoring only.
 *
 * @param {string} writer
 * @param {number} base
 * @param {number} count
 * @param {unknown} payload
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord[]}
 */
function buildChain(writer, base, count, payload) {
    const records = [];
    let sequence = 0;
    for (let id = 0; id < count; id += 1) {
        sequence += 1;
        records.push(made(makeValueEvent(
            {
                id: writer + ":" + String(sequence),
                context: makeJournalFrontierFromText(
                    sequence === 1 ? [] : [[writer, String(sequence - 1)]]
                ),
                authorityTime: authorityOf(base + id * 2),
                node: nodeOf(id),
            },
            id + "-abcdefghi",
            payload,
            NOW,
            LATER,
            "compute"
        )));
    }
    return records;
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {import("../src/generators/incremental_graph/journal").JournalReplica}
 */
function replicaOf(records) {
    const byWriter = new Map();
    for (const record of records) {
        const name = journalAuthorToString(record.id.author);
        const stream = byWriter.get(name) ?? [];
        stream.push(record);
        byWriter.set(name, stream);
    }
    return made(makeJournalReplica([...byWriter.entries()]));
}

describe("reset Pass 1 chunked authoring over a threshold-sized production target", () => {
    test("reset authors a presence population larger than one chunk and projects to the reference replay", async () => {
        // The receiver retains every target node but with a different payload,
        // and its authority is higher than the source's, so the raw union
        // selects the receiver's occurrence for every node and Pass 1 must
        // author all 66 target occurrences: two bounded-chunk flushes.
        const receiverRecords = buildChain(WRITER_LOCAL, 1000, NODE_COUNT, PAYLOAD);
        const sourceRecords = buildChain(WRITER_PEER, 10, NODE_COUNT, PAYLOAD_SOURCE);

        const receiver = makeReplicaSource(replicaOf(receiverRecords));
        const built = await buildRetainedReplayState({
            source: receiver,
            localWriter: LOCAL_AUTHOR,
            currentInputKeysOfNode: chainInputs,
        });
        if ("error" in built) {
            throw new Error("the receiver fixture has no retained state: " + built.error.message);
        }
        const sourceJournal = makeReplicaSource(replicaOf(sourceRecords));
        const projection = await projectRetainedJournal({
            source: sourceJournal,
            localWriter: LOCAL_AUTHOR,
            currentInputKeysOfNode: chainInputs,
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
        const lastLocal = receiverRecords.slice(-1)[0];
        if (lastLocal === undefined) {
            throw new Error("the receiver fixture has no local record");
        }
        const result = await withCollectedRecords(await resetToSource({
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
            currentInputKeysOfNode: chainInputs,
            receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
        }));
        if (!("outcome" in result)) {
            throw new Error("reset failed with " + result.error.name + ": " + result.error.message);
        }
        const { outcome } = result;

        const values = outcome.publication.records.filter((record) => record.kind === "value");
        // Every target node is re-authored, one chunk of 64 plus a remainder.
        expect(values).toHaveLength(NODE_COUNT);
        expect(values.length).toBeGreaterThan(64);
        expect(values.every((record) => record.reason === "reset")).toBe(true);

        // The chunked publication is one contiguous own-writer range in
        // canonical request order.
        const sequences = outcome.publication.records.map((record) => Number(record.id.sequence));
        for (let index = 1; index < sequences.length; index += 1) {
            expect(sequences[index]).toBe(sequences[index - 1] + 1);
        }

        const reference = await projectRetainedJournal({
            source: makeReplicaSource(replicaOf([...receiverRecords, ...outcome.records])),
            localWriter: LOCAL_AUTHOR,
            currentInputKeysOfNode: chainInputs,
        });
        if (reference instanceof Error) {
            throw new Error("the reference replay failed: " + reference.message);
        }
        expect(outcome.projection).toEqual(reference);
        expect(outcome.projection.occurrences).toHaveLength(NODE_COUNT);
    });
});
