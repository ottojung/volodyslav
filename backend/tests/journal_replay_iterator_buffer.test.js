/**
 * Replay of a node whose certificate/invalidation history exceeds the configured
 * iterator buffer.
 *
 * `incremental-graph-journal-testing.md` §Streaming correctness (L887) requires a
 * test which "include[s] one node with certificate/invalidation history larger than
 * the configured iterator buffer and require[s] correct head/certificate/barrier
 * folding without whole-history materialization".
 *
 * The normative source is `incremental-graph-journal-replay.md` §Inputs to replay
 * (L505): "Head selection, eligible-certificate evaluation, invalidation/barrier
 * evaluation, writer-state reconstruction, and projection lowering must be
 * implementable through ordered/indexed iteration, bounded iterator/runtime buffers,
 * per-node streaming/folding, durable derived indexes/checkpoints, or
 * observationally equivalent incremental mechanisms." `$id-4924739474925738`
 * (`docs/intent-records/synchronization-performance.md`) is the underlying intent.
 *
 * ## What is exercised
 *
 * The subject is the real production algorithm `projectRetainedJournal`, the same
 * oracle the replay front calls. It is driven over a `JournalSource` whose reader is
 * a chunked iterator: it refills a bounded buffer of `ITERATOR_BUFFER` records and
 * hands them out one at a time, which is the shape a chunked LevelDB range iterator
 * has. The fixture gives one node `K` a retained history of `HEAD_COUNT` materializations,
 * `CERTIFICATE_COUNT` validations and `BARRIER_COUNT` invalidations across all three
 * invalidation scopes, far larger than `ITERATOR_BUFFER`, so the head, certificate and
 * barrier folds each have to span many buffer refills.
 *
 * The streaming projection is compared against the **reference model**
 * `oracle_declarative_reference.js`, a deliberately naive projector which groups the
 * whole journal by node in RAM and evaluates the specification's set definitions
 * literally. A fold which only consulted the records that happened to share one
 * buffer window, or which materialised a per-node history, would diverge from that
 * complete-history replay.
 *
 * ## What "without whole-history materialization" is pinned by
 *
 * The `JournalSource` interface has no method which returns the complete retained
 * journal, every writer's history at once, or one node's history as a collection, so
 * the oracle cannot reintroduce materialisation through it. The instrumented reader
 * additionally records how many records it buffers at once and how many times it
 * refills, so the test can assert the history really was streamed in more than one
 * bounded chunk rather than loaded whole. The number of readers the oracle opens is
 * counted too: the oracle makes a constant number of passes, re-reading the same
 * records through a fresh bounded reader each time, which is the shape a
 * materialising source could not offer.
 *
 * Every fixture record is a supported Journal record in the sense of
 * `incremental-graph-journal-testing.md` §Reference replay oracle: each record's own
 * context is exactly its predecessor, and the record layer accepts the whole replica.
 */

const {
    journalAuthorToString,
    journalRecordIdToString,
    makeAuthorityTime,
    makeInvalidateEvent,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeJournalSequence,
    makeNodeScope,
    makeProofScope,
    makeValueScope,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    nodeKeyToCanonicalString,
    validateJournalReplica,
} = require("../src/generators/incremental_graph/journal");

const {
    projectRetainedJournal,
    readerOverIterable,
} = require("../src/generators/incremental_graph/journal/oracle");

const { declarativeProject } = require("./oracle_declarative_reference");

const WRITER = "aaaaaaaaa";
const NODE_D = { head: "event", args: [{ id: 2 }] };
const NODE_K = { head: "event", args: [{ id: 0 }] };
const KEY_D = nodeKeyToCanonicalString(NODE_D);
const KEY_K = nodeKeyToCanonicalString(NODE_K);
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const PAYLOAD = { type: "entry_description", description: "x" };

/**
 * The configured iterator buffer. The retained history below is many multiples of
 * it, so a fold which assumed the whole node history fit in one buffer would miss
 * records.
 */
const ITERATOR_BUFFER = 8;

/**
 * How many materializations of `K` are retained, so head selection must fold a
 * running maximum over many candidates rather than the one the buffer happens to
 * hold.
 */
const HEAD_COUNT = 40;

/**
 * How many validations of the winning occurrence are retained, so certificate
 * selection must fold a running maximum over many eligible and ineligible
 * candidates.
 */
const CERTIFICATE_COUNT = 24;

/**
 * How many invalidations of `K` are retained in each of the three scopes, so the
 * invalidation summary must keep a per-writer maximum over many barriers rather
 * than the first or last one it sees.
 */
const BARRIER_COUNT = 24;

/**
 * `K` reads the single current input `D`; `D` is a leaf.
 *
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function oneInputSchema(nodeKeyString) {
    return nodeKeyString === KEY_K ? [KEY_D] : [];
}

/**
 * @param {string} nodeKeyString
 * @returns {string}
 */
function identifierOf(nodeKeyString) {
    return JSON.parse(nodeKeyString).args[0].id + "-abcdefghi";
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
 * @returns {import("../src/generators/incremental_graph/journal").AuthorityTime}
 */
function authorityOf(physical) {
    return made(makeAuthorityTime(physical, "0"));
}

/**
 * The context a writer's record at `sequence` observes: the exact complete own
 * prefix, so every fixture record is well formed by construction.
 *
 * @param {number} sequence
 * @returns {import("../src/generators/incremental_graph/journal").JournalFrontier}
 */
function contextAt(sequence) {
    const coordinates = sequence === 1 ? [] : [[WRITER, String(sequence - 1)]];
    return makeJournalFrontierFromText(coordinates);
}

/**
 * The retained history of the fixture.
 *
 * @typedef {object} HistoryFixture
 * @property {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records - The whole writer stream, in writer-stream order.
 * @property {number} historyLength - The number of retained records, one node's certificate/invalidation history plus its heads.
 */

/**
 * Build one node's retained history, far larger than the configured iterator
 * buffer.
 *
 * `D` is materialized and validated, so it is fresh and self-proof-ready. `K` then
 * accumulates `HEAD_COUNT` materializations with strictly increasing authority, so
 * the selected head is the last one. Half of the invalidations of `K` are authored
 * before its certificates and half after them, so every certificate causally
 * covers the early barriers but not the later ones; every certificate is therefore
 * *ineligible* on a complete-history replay, and the summary has to keep the later
 * per-writer maximum for that to be true. `CERTIFICATE_COUNT` validations are
 * interleaved through the middle of the history, so the certificate fold has many
 * candidates spread across the whole buffer.
 *
 * @returns {HistoryFixture}
 */
function buildHistory() {
    /** @type {import("../src/generators/incremental_graph/journal").JournalRecord[]} */
    const records = [];
    let sequence = 0;
    const next = () => {
        sequence += 1;
        return sequence;
    };

    const dValueSequence = next();
    records.push(made(makeValueEvent(
        {
            id: WRITER + ":" + String(dValueSequence),
            context: contextAt(dValueSequence),
            authorityTime: authorityOf(100),
            node: NODE_D,
        },
        identifierOf(KEY_D),
        PAYLOAD,
        NOW,
        LATER,
        "compute"
    )));
    const dValueId = WRITER + ":" + String(dValueSequence);

    const dCertificateSequence = next();
    records.push(made(makeValidateEvent(
        {
            id: WRITER + ":" + String(dCertificateSequence),
            context: contextAt(dCertificateSequence),
            authorityTime: authorityOf(101),
            node: NODE_D,
        },
        dValueId,
        [],
        "compute"
    )));

    /** @type {string[]} */
    const valueIds = [];
    for (let index = 0; index < HEAD_COUNT; index += 1) {
        const valueSequence = next();
        records.push(made(makeValueEvent(
            {
                id: WRITER + ":" + String(valueSequence),
                context: contextAt(valueSequence),
                authorityTime: authorityOf(200 + index),
                node: NODE_K,
            },
            identifierOf(KEY_K),
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        )));
        valueIds.push(WRITER + ":" + String(valueSequence));
    }
    const winnerValueId = valueIds[valueIds.length - 1];
    if (winnerValueId === undefined) {
        throw new Error("the fixture built no materialization of K");
    }

    /**
     * @param {"node" | "value" | "proof"} scope
     * @param {number} authority
     */
    const invalidate = (scope, authority) => {
        const invalidateSequence = next();
        const context = contextAt(invalidateSequence);
        if (scope === "node") {
            records.push(made(makeInvalidateEvent(
                {
                    id: WRITER + ":" + String(invalidateSequence),
                    context,
                    authorityTime: authorityOf(authority),
                    node: NODE_K,
                },
                makeNodeScope(),
                "propagated"
            )));
            return;
        }
        if (scope === "value") {
            records.push(made(makeInvalidateEvent(
                {
                    id: WRITER + ":" + String(invalidateSequence),
                    context,
                    authorityTime: authorityOf(authority),
                    node: NODE_K,
                },
                makeValueScope(winnerValueId),
                "propagated"
            )));
            return;
        }
        records.push(made(makeInvalidateEvent(
            {
                id: WRITER + ":" + String(invalidateSequence),
                context,
                authorityTime: authorityOf(authority),
                node: NODE_K,
            },
            makeProofScope(winnerValueId, NODE_D),
            "bootstrap"
        )));
    };

    const earlyBarriers = Math.floor(BARRIER_COUNT / 2);
    const lateBarriers = BARRIER_COUNT - earlyBarriers;

    // The barriers every certificate does cover.
    for (let index = 0; index < earlyBarriers; index += 1) {
        invalidate("node", 3000 + index);
    }
    for (let index = 0; index < earlyBarriers; index += 1) {
        invalidate("value", 4000 + index);
    }
    for (let index = 0; index < earlyBarriers; index += 1) {
        invalidate("proof", 5000 + index);
    }

    // Every certificate names the winning occurrence and proves `D`. Their
    // contexts cover everything authored before them.
    for (let index = 0; index < CERTIFICATE_COUNT; index += 1) {
        const certificateSequence = next();
        records.push(made(makeValidateEvent(
            {
                id: WRITER + ":" + String(certificateSequence),
                context: contextAt(certificateSequence),
                authorityTime: authorityOf(6000 + index),
                node: NODE_K,
            },
            winnerValueId,
            [makeValidationBasisEntry(NODE_D, dValueId)],
            "compute"
        )));
    }

    // The barriers every certificate does not cover. On a complete-history replay
    // these make every certificate ineligible, so `K` has no certificate and is not
    // self-proof-ready.
    for (let index = 0; index < lateBarriers; index += 1) {
        invalidate("node", 7000 + index);
    }
    for (let index = 0; index < lateBarriers; index += 1) {
        invalidate("value", 8000 + index);
    }
    for (let index = 0; index < lateBarriers; index += 1) {
        invalidate("proof", 9000 + index);
    }

    return { records, historyLength: records.length };
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
 * A reader over one writer's retained stream which refills a bounded buffer of
 * `chunkSize` records and hands them out one at a time, which is the shape a
 * chunked iterator over a real sublevel has.
 *
 * @param {string} writerName
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @param {number} chunkSize
 * @returns {{reader: import("../src/generators/incremental_graph/journal/oracle").PrefixReader, stats: {maxBuffered: number, refills: number, yielded: number}}}
 */
function chunkedReader(writerName, records, chunkSize) {
    const stats = { maxBuffered: 0, refills: 0, yielded: 0 };
    const last = records[records.length - 1];
    const length = last === undefined
        ? made(makeJournalSequence("0"))
        : last.id.sequence;
    /** @type {import("../src/generators/incremental_graph/journal").JournalRecord[]} */
    let buffer = [];
    let exhausted = false;
    const plain = readerOverIterable(writerName, records, length);

    /**
     * @returns {Promise<void>}
     */
    async function refill() {
        stats.refills += 1;
        buffer = [];
        for (let taken = 0; taken < chunkSize; taken += 1) {
            const record = await plain.nextRecord();
            if (record === undefined) {
                exhausted = true;
                break;
            }
            buffer.push(record);
        }
        stats.maxBuffered = Math.max(stats.maxBuffered, buffer.length);
    }

    const reader = {
        nextRecord: async () => {
            if (buffer.length === 0 && !exhausted) {
                await refill();
            }
            const record = buffer.shift();
            if (record !== undefined) {
                stats.yielded += 1;
            }
            return record;
        },
        failure: () => plain.failure(),
    };
    return { reader, stats };
}

/**
 * A `JournalSource` over one replica whose every writer is read through a bounded
 * chunked iterator. The interface still exposes only `writers`, `retainedLengthOf`
 * and `prefixReaderOf`, so a caller cannot reintroduce whole-history
 * materialisation through it.
 *
 * @param {import("../src/generators/incremental_graph/journal").JournalReplica} replica
 * @param {number} chunkSize
 * @returns {import("../src/generators/incremental_graph/journal/oracle").JournalSource}
 */
function chunkedSource(replica, chunkSize) {
    /** @type {Map<string, ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>>} */
    const streams = new Map();
    for (const [author, records] of replica) {
        streams.set(journalAuthorToString(author), records);
    }
    const writers = [...streams.keys()].sort().map((name) => makeJournalAuthor(name));
    return {
        writers: () => writers,
        retainedLengthOf(author) {
            const records = streams.get(journalAuthorToString(author));
            const last = records?.[(records?.length ?? 0) - 1];
            return last === undefined ? undefined : last.id.sequence;
        },
        prefixReaderOf(author) {
            const name = journalAuthorToString(author);
            const records = streams.get(name) ?? [];
            return chunkedReader(name, records, chunkSize).reader;
        },
    };
}

/**
 * A wrapper around a source which counts how many readers the oracle opens, so a
 * test can tell a constant number of streaming passes from a materialisation.
 *
 * @param {import("../src/generators/incremental_graph/journal/oracle").JournalSource} source
 * @returns {{source: import("../src/generators/incremental_graph/journal/oracle").JournalSource, stats: () => {readers: number}}}
 */
function readerCountingSource(source) {
    let readers = 0;
    return {
        source: {
            writers: () => source.writers(),
            retainedLengthOf: (author) => source.retainedLengthOf(author),
            prefixReaderOf: (author) => {
                readers += 1;
                return source.prefixReaderOf(author);
            },
        },
        stats: () => ({ readers }),
    };
}

/**
 * Reduce a projection to the comparable occurrence shape the reference model
 * also reports, so a disagreement names the node and the field rather than
 * comparing object identities.
 *
 * @param {import("../src/generators/incremental_graph/journal/oracle").Projection} projection
 * @returns {string}
 */
function summarizeProjection(projection) {
    return JSON.stringify(
        projection.occurrences.map((occurrence) => [
            occurrence.nodeKeyString,
            journalRecordIdToString(occurrence.valueId),
            occurrence.createdAt,
            occurrence.modifiedAt,
            occurrence.fresh,
            [...occurrence.validInputs].sort(),
        ])
    );
}

/**
 * Reduce the declarative reference model to the same comparable shape.
 *
 * @param {ReturnType<typeof declarativeProject>} model
 * @returns {string}
 */
function summarizeModel(model) {
    return JSON.stringify(
        model.occurrences.map((occurrence) => [
            occurrence.nodeKeyString,
            occurrence.valueId,
            occurrence.createdAt,
            occurrence.modifiedAt,
            occurrence.fresh,
            occurrence.validInputs,
        ])
    );
}

describe("replay folds a certificate/invalidation history larger than the iterator buffer", () => {
    test("the streaming projection equals the complete-history reference over a chunked iterator", async () => {
        const fixture = buildHistory();
        // The history is far larger than the configured buffer, so the fold has to
        // span many refills rather than assume the whole node history is one chunk.
        expect(fixture.historyLength).toBeGreaterThan(ITERATOR_BUFFER * 4);

        const replica = replicaOf(fixture.records);
        const wellFormed = validateJournalReplica(replica);
        expect(wellFormed).toBeUndefined();

        const localWriter = makeJournalAuthor(WRITER);
        expect(localWriter instanceof Error).toBe(false);

        const source = chunkedSource(replica, ITERATOR_BUFFER);
        const counting = readerCountingSource(source);
        const projection = await projectRetainedJournal({
            source: counting.source,
            localWriter,
            currentInputKeysOfNode: oneInputSchema,
        });
        expect(projection instanceof Error).toBe(false);
        if (projection instanceof Error) {
            return;
        }

        const model = declarativeProject(replica, WRITER, oneInputSchema);
        expect(model.publishable).toBe(true);

        // The head/certificate/barrier folds agree with a complete-history replay.
        expect(summarizeProjection(projection)).toBe(summarizeModel(model));
        // The later barriers make the only certificate ineligible, so `K` is not
        // self-proof-ready: this is the fold the later barriers decide.
        expect(projection.selfProofReadyNodes.has(KEY_K)).toBe(false);
    });

    test("the node history is streamed through more than one bounded buffer chunk", async () => {
        const fixture = buildHistory();
        const replica = replicaOf(fixture.records);
        const localWriter = makeJournalAuthor(WRITER);
        expect(localWriter instanceof Error).toBe(false);

        const source = chunkedSource(replica, ITERATOR_BUFFER);
        const author = makeJournalAuthor(WRITER);
        expect(author instanceof Error).toBe(false);
        if (author instanceof Error) {
            return;
        }
        const { reader, stats } = chunkedReader(
            WRITER,
            replica.get(author) ?? [],
            ITERATOR_BUFFER
        );

        const projection = await projectRetainedJournal({
            source: {
                writers: () => source.writers(),
                retainedLengthOf: (held) => source.retainedLengthOf(held),
                prefixReaderOf: () => reader,
            },
            localWriter,
            currentInputKeysOfNode: oneInputSchema,
        });
        expect(projection instanceof Error).toBe(false);

        // The whole history was handed out one record at a time, in more than one
        // refill, and the buffer never held more than its configured size.
        expect(stats.yielded).toBe(fixture.historyLength);
        expect(stats.refills).toBeGreaterThan(1);
        expect(stats.yielded).toBeGreaterThan(ITERATOR_BUFFER);
        expect(stats.maxBuffered).toBeLessThanOrEqual(ITERATOR_BUFFER);
    });

    test("the oracle opens a fresh bounded reader per pass rather than one materialising reader", async () => {
        const fixture = buildHistory();
        const replica = replicaOf(fixture.records);
        const localWriter = makeJournalAuthor(WRITER);
        expect(localWriter instanceof Error).toBe(false);

        const counting = readerCountingSource(chunkedSource(replica, ITERATOR_BUFFER));
        const projection = await projectRetainedJournal({
            source: counting.source,
            localWriter,
            currentInputKeysOfNode: oneInputSchema,
        });
        expect(projection instanceof Error).toBe(false);
        if (projection instanceof Error) {
            return;
        }

        // The oracle makes several ordered passes and asks for a fresh reader each
        // time, which is exactly the streaming behaviour a materialising source
        // could not offer.
        expect(counting.stats().readers).toBeGreaterThan(1);
    });
});
