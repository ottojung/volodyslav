/**
 * Production reset must resolve a small affected closure without asking the
 * receiver's retained source for unrelated old records. The retained replay
 * state is the activated index; reset may read the missing source suffix and
 * update that state, but must not fall back to a history scan.
 */

const {
    makeAuthorityTime,
    makeJournalAuthor,
    journalAuthorToString,
    makeJournalFrontierFromText,
    makeJournalSequence,
    makeJournalReplica,
    makeReplicaSource,
    makeValueEvent,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal");
const { SnapshotIdentityClass } = require("../src/generators/incremental_graph/journal_sync");
const {
    buildRetainedReplayState,
    makeResetSource,
    resetToSource,
} = require("../src/generators/incremental_graph/journal_reset");
const { withCollectedRecords } = require("./journal_record_growth_helper");

const LOCAL = "aaaaaaaaa";
const PEER = "bbbbbbbbb";
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const NODE = (id) => ({ head: "event", args: [{ id }] });
const PAYLOAD = { type: "entry_description", description: "x" };
const RETAINED_COUNT = 48;

function made(value) {
    if (value instanceof Error) {
        throw new Error("invalid test record: " + value.message);
    }
    return value;
}

function recordsOf(author, count, startAuthority) {
    return Array.from({ length: count }, (_, index) => made(makeValueEvent(
        {
            id: author + ":" + (index + 1),
            context: makeJournalFrontierFromText(index === 0 ? [] : [[author, String(index)]]),
            authorityTime: makeAuthorityTime(startAuthority + index, "0"),
            node: NODE(index),
        },
        index + "-abcdefghi",
        PAYLOAD,
        NOW,
        LATER,
        "compute"
    )));
}

function replica(records) {
    const byWriter = new Map();
    for (const record of records) {
        const author = record.id.author;
        const name = journalAuthorToString(author);
        const stream = byWriter.get(name) ?? { author, records: [] };
        stream.records.push(record);
        byWriter.set(name, stream);
    }
    return made(makeJournalReplica([...byWriter.values()].map(({ author, records: stream }) => [author, stream])));
}

function guardUnrelatedRetainedHistory(source, readCounter) {
    const originalReader = source.prefixReaderOf;
    const originalSuffixReader = source.suffixReaderOf;
    return {
        writers: source.writers,
        retainedLengthOf: source.retainedLengthOf,
        prefixReaderOf(author) {
            if (journalAuthorToString(author) === LOCAL) {
                readCounter.localHistoryReaderOpened += 1;
                throw new Error("reset attempted to rescan receiver retained history");
            }
            return originalReader(author);
        },
        suffixReaderOf(author, sequence) {
            if (journalAuthorToString(author) !== LOCAL) {
                return originalSuffixReader(author, sequence);
            }
            readCounter.localHistoryReaderOpened += 1;
            throw new Error("reset attempted to rescan receiver retained history");
        },
    };
}

test("resetToSource repairs a missing node from the indexed closure without rescanning the receiver journal", async () => {
    const receiverRecords = recordsOf(LOCAL, RETAINED_COUNT, 1000);
    const sourceRecords = recordsOf(PEER, 1, 10);
    const receiverBase = makeReplicaSource(replica(receiverRecords));
    let foreignSuffixReads = 0;
    const reads = { localHistoryReaderOpened: 0 };
    const guardedReceiver = guardUnrelatedRetainedHistory(receiverBase, reads);
    const receiver = {
        writers: guardedReceiver.writers,
        retainedLengthOf: guardedReceiver.retainedLengthOf,
        prefixReaderOf: guardedReceiver.prefixReaderOf,
        suffixReaderOf: guardedReceiver.suffixReaderOf,
    };
    const sourceJournalBase = makeReplicaSource(replica(sourceRecords));
    const sourceJournal = {
        writers: sourceJournalBase.writers,
        retainedLengthOf: sourceJournalBase.retainedLengthOf,
        prefixReaderOf: sourceJournalBase.prefixReaderOf,
        suffixReaderOf(author, sequence) {
            foreignSuffixReads += 1;
            return sourceJournalBase.suffixReaderOf(author, sequence);
        },
    };
    const currentInputKeysOfNode = () => [];

    const built = await buildRetainedReplayState({
        source: receiverBase,
        localWriter: makeJournalAuthor(LOCAL),
        currentInputKeysOfNode,
    });
    if ("error" in built) {
        throw new Error("receiver state failed to build: " + built.error.message);
    }

    const sourceProjection = await projectRetainedJournal({
        source: sourceJournalBase,
        localWriter: makeJournalAuthor(PEER),
        currentInputKeysOfNode,
    });
    if (sourceProjection instanceof Error) {
        throw new Error("source projection failed: " + sourceProjection.message);
    }

    const result = await resetToSource({
        receiver,
        retainedState: built.state,
        source: makeResetSource({
            databaseVersion: "v1",
            graphSchemeString: "scheme",
            journal: sourceJournal,
            projection: sourceProjection,
        }),
        localWriter: makeJournalAuthor(LOCAL),
        committed: {
            localWriter: makeJournalAuthor(LOCAL),
            writerHead: makeJournalSequence(String(RETAINED_COUNT)),
            committedFrontier: makeJournalFrontierFromText([[LOCAL, String(RETAINED_COUNT)]]),
            authorityHighWater: makeAuthorityTime(5000, "0"),
            allocatorWatermark: 0,
        },
        observedHighWater: makeAuthorityTime(5000, "0"),
        publicationInstant: 1700000000000,
        currentInputKeysOfNode,
        receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
    });
    expect("outcome" in result).toBe(true);
    if (!("outcome" in result)) {
        throw new Error("reset failed: " + result.error.message);
    }
    await withCollectedRecords(result);

    expect(reads.localHistoryReaderOpened).toBe(0);
    expect(foreignSuffixReads).toBeGreaterThan(0);
    expect(result.outcome.projection.occurrences.map((item) => item.nodeKey.args[0].id))
        .toEqual([0]);
});
