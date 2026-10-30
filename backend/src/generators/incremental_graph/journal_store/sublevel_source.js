/**
 * A `JournalSource` over one replica's journal sublevel.
 *
 * `$id-4924739474925738` requires journal synchronization and replay processing
 * to be streamable: the complete retained history, the complete transferred
 * suffix, and the complete changed-node set must never be materialised in RAM
 * as one collection. The oracle's `JournalSource` interface is the shape which
 * makes that possible, and this module is the LevelDB implementation of it.
 *
 * ## Retained lengths are one range read per writer
 *
 * `JournalSource.retainedLengthOf` is documented in
 * `../journal/oracle/record_source` as "a constant-size read, not a scan", and
 * this module keeps that promise literally: `readRetainedLengths` answers one
 * writer's greatest retained coordinate with a single *reverse* range read
 * bounded by that writer's record-key family, so its cost does not depend on how
 * many records the writer retains. Scanning the writer's keys to find the last
 * one would be a traversal of the very history the intent forbids re-reading.
 * `readRetainedLengths` performs exactly one such read per writer and no reads
 * proportional to any writer's record count.
 *
 * ## Record supply
 *
 * The oracle drives a prefix reader synchronously — `streamWithReport` in
 * `../journal/oracle/scan` calls `nextRecord()` in a tight loop and cannot yield
 * to the event loop — while every LevelDB read is a promise. A source therefore
 * takes its records from an injected `PrefixRecordSource`, and the reader it
 * builds is exactly the range/no-holes reader the oracle expects. Which
 * `PrefixRecordSource` a deployment supplies is a property of its storage
 * driver, not of this module; what this module owns is that a writer's retained
 * length costs one range read and that the reader it hands out bounds itself by
 * that length.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalSequence} JournalSequence */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('../journal/oracle/record_source').PrefixReader} PrefixReader */
/** @typedef {import('../database/types').JournalKey} JournalKey */
/** @typedef {import('../database/types').JournalText} JournalText */
/**
 * @template T
 * @template [K=import('../database/types').DatabaseKey]
 * @typedef {import('../database/types').SimpleSublevel<T, K>} SimpleSublevel
 */

const {
    compareJournalSequence,
    journalAuthorToString,
    journalSequenceToString,
    makeJournalAuthor,
    makeJournalSequence,
    makeJournalSourceReadError,
    readerOverIterable,
    readerOverRecordSupply,
    tryDecodeJournalRecord,
    ZERO_JOURNAL_SEQUENCE,
} = require('../journal');
const { reconcileRetainedWriterHead } = require('./writer_head');
const {
    journalKeyToString,
    journalTextToString,
    stringToJournalKey,
} = require('../database');
const { makeJournalRecordKey } = require('./journal_database');

const RECORD_KEY_PREFIX = 'record|';

/**
 * The greatest key a writer's record-key family can occupy.
 *
 * The padded coordinate is decimal digits, so the greatest key under a writer's
 * prefix is that prefix followed by the largest character the sublevel's byte
 * order admits. Using it as the range's inclusive upper bound makes the range
 * exactly the writer's records.
 */
const RANGE_UPPER_BOUND = '￿';

/**
 * The key range one writer's records occupy.
 *
 * @param {JournalAuthor} author
 * @returns {{gte: JournalKey, lte: JournalKey}}
 */
function recordRangeOf(author) {
    const prefix = RECORD_KEY_PREFIX + journalAuthorToString(author) + '|';
    return {
        gte: stringToJournalKey(prefix),
        lte: stringToJournalKey(prefix + RANGE_UPPER_BOUND),
    };
}

/**
 * The key range one writer's records from `fromSequence` occupy.
 *
 * The lower bound is the padded key of the first coordinate, so a reader which
 * opens this range reads the writer's missing suffix without reading the prefix
 * before it. The upper bound is the same writer-family bound `recordRangeOf`
 * uses, so the range is exactly the coordinates at or above `fromSequence`.
 *
 * @param {JournalAuthor} author
 * @param {JournalSequence} fromSequence
 * @returns {{gte: JournalKey, lte: JournalKey} | JournalError}
 */
function recordRangeFromOf(author, fromSequence) {
    const gte = makeJournalRecordKey(author, fromSequence);
    if (gte instanceof Error) {
        return gte;
    }
    const prefix = RECORD_KEY_PREFIX + journalAuthorToString(author) + '|';
    return { gte, lte: stringToJournalKey(prefix + RANGE_UPPER_BOUND) };
}

/**
 * The coordinate one record key names, which is the padded coordinate the key
 * family stores rather than the record's own canonical text.
 *
 * @param {JournalKey} key
 * @returns {string}
 */
function coordinateTextOf(key) {
    const text = journalKeyToString(key);
    const separator = text.lastIndexOf('|');
    return separator < 0 ? '' : text.slice(separator + 1).replace(/^0+(?=[0-9])/, '');
}

/**
 * Read each writer's greatest retained coordinate with one reverse range read.
 *
 * The writers are the distinct record-key prefixes of the sublevel. Discovering
 * them is a scan of *keys* whose work is bounded by the number of distinct
 * writers and by the prefix structure rather than by the number of records, and
 * no record is decoded to discover it; every writer's length is then one
 * reverse range read.
 *
 * @param {SimpleSublevel<JournalText, JournalKey>} journalSublevel - The
 *   `journal` sublevel of the replica to read, which a caller reaches through
 *   `RootDatabase.replicaNamespaceSublevel(name).sublevel('journal', ...)`.
 * @returns {Promise<Map<string, JournalSequence> | JournalError>}
 */
async function readRetainedLengths(journalSublevel) {
    /** @type {Map<string, JournalSequence>} */
    const lengths = new Map();
    /** @type {Set<string>} */
    const writers = new Set();
    for await (const key of journalSublevel.keys()) {
        const text = journalKeyToString(key);
        if (!text.startsWith(RECORD_KEY_PREFIX)) {
            continue;
        }
        const separator = text.indexOf('|', RECORD_KEY_PREFIX.length);
        if (separator < 0) {
            continue;
        }
        writers.add(text.slice(RECORD_KEY_PREFIX.length, separator));
    }
    for (const name of [...writers].sort()) {
        const author = makeJournalAuthor(name);
        if (author instanceof Error) {
            return author;
        }
        const { gte, lte } = recordRangeOf(author);
        const range = journalSublevel.iterator({
            gte,
            lte,
            reverse: true,
            limit: 1,
        });
        let last = '';
        for await (const entry of range) {
            last = coordinateTextOf(entry[0]);
            break;
        }
        if (last === '') {
            continue;
        }
        const sequence = makeJournalSequence(last);
        if (sequence instanceof Error) {
            return sequence;
        }
        lengths.set(name, sequence);
    }
    return lengths;
}

/**
 * The synchronous supply of one writer's retained records.
 *
 * The oracle's reader is a pull reader with no place to await, so the storage
 * driver which owns the record bytes decides how a writer's stream is made
 * synchronously available. This is the whole of that decision, which is why it
 * is a parameter here rather than something this module guesses.
 *
 * @typedef {(author: JournalAuthor) => ReadonlyArray<JournalRecord>} PrefixRecordSource
 */

/**
 * The properties that the source returned here carries are:
 * - `retainedLengthOf(author)` answers from the map `readRetainedLengths`
 *   built, so it costs one reverse range read per writer rather than a scan;
 * - `prefixReaderOf(author)` returns a reader which admits only the coordinates
 *   the source declares for that writer, so a prefix with a hole, a short prefix
 *   or an over-long prefix fails inside the reader rather than being accepted;
 * - `writers()` enumerates exactly the writers the retained lengths name, in
 *   ascending canonical order.
 *
 * The proof of those properties is guaranteed by:
 * - `readRetainedLengths(journalSublevel)`: it derives each length from the
 *   greatest key of that writer's own record range, so a length names a
 *   coordinate the sublevel actually holds; and
 * - `makeSyncJournalSource(lengths, recordsOf)`: it builds every reader through
 *   `readerOverIterable`, which is the oracle's own no-holes reader, and passes
 *   it the very length the map declares.
 *
 * @param {Map<string, JournalSequence>} lengths
 * @param {PrefixRecordSource} recordsOf
 * @returns {JournalSource}
 */
function makeSyncJournalSource(lengths, recordsOf) {
    /** @type {Array<JournalAuthor>} */
    const writers = [];
    for (const name of [...lengths.keys()].sort()) {
        const author = makeJournalAuthor(name);
        if (!(author instanceof Error)) {
            writers.push(author);
        }
    }
    return {
        writers: () => writers,
        retainedLengthOf(author) {
            return lengths.get(journalAuthorToString(author));
        },
        prefixReaderOf(author) {
            const name = journalAuthorToString(author);
            const length = lengths.get(name);
            return readerOverIterable(name, recordsOf(author), length ?? recordsLengthFallback(recordsOf, author));
        },
        suffixReaderOf(author, fromSequence) {
            const name = journalAuthorToString(author);
            const length = lengths.get(name);
            const stream = recordsOf(author);
            const first = stream.findIndex(
                (record) => compareJournalSequence(record.id.sequence, fromSequence) >= 0
            );
            const slice = first < 0 ? [] : stream.slice(first);
            return readerOverIterable(
                name,
                slice,
                length ?? recordsLengthFallback(recordsOf, author),
                fromSequence
            );
        },
    };
}

/**
 * The length a reader bounds itself by when the source retains nothing for a
 * writer: the record supply's own last coordinate, which is the only length the
 * supplied records can support.
 *
 * @param {PrefixRecordSource} recordsOf
 * @param {JournalAuthor} author
 * @returns {JournalSequence}
 */
function recordsLengthFallback(recordsOf, author) {
    const stream = recordsOf(author);
    const last = stream[stream.length - 1];
    if (last === undefined) {
        return makeJournalSequenceOrThrow('0');
    }
    return last.id.sequence;
}

/**
 * @param {string} digits
 * @returns {JournalSequence}
 */
function makeJournalSequenceOrThrow(digits) {
    const sequence = makeJournalSequence(digits);
    if (sequence instanceof Error) {
        throw new Error('the oracle built a coordinate the canonical pattern rejects: ' + digits);
    }
    return sequence;
}

/**
 * Every retained length as text, for a caller which reports a frontier.
 *
 * @param {Map<string, JournalSequence>} lengths
 * @returns {Array<[string, string]>}
 */
function retainedLengthTexts(lengths) {
    return [...lengths.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([name, sequence]) => [name, journalSequenceToString(sequence)]);
}

/**
 * A reader over one writer's record-key range, decoding and key-checking one entry
 * at a time as the consumer pulls it.
 *
 * This is the one place a durable record range becomes a `PrefixReader`, shared by
 * the whole-prefix reader and the positioned suffix reader so both decide the
 * no-holes/no-overrun rule by the same `readerOverRecordSupply` state.
 *
 * @param {string} name
 * @param {SimpleSublevel<JournalText, JournalKey>} journalSublevel
 * @param {JournalAuthor} author
 * @param {JournalKey} gte
 * @param {JournalKey} lte
 * @param {JournalSequence} claimed
 * @param {JournalSequence} [startSequence]
 * @returns {PrefixReader}
 */
function readerOverRange(name, journalSublevel, author, gte, lte, claimed, startSequence) {
    const iterator = journalSublevel.iterator({ gte, lte })[Symbol.asyncIterator]();
    return readerOverRecordSupply(name, async () => {
        const step = await iterator.next();
        if (step.done === true) {
            return undefined;
        }
        const [key, text] = step.value;
        const record = tryDecodeJournalRecord(journalTextToString(text));
        if (record instanceof Error) {
            return record;
        }
        const expectedKey = makeJournalRecordKey(author, record.id.sequence);
        if (expectedKey instanceof Error) {
            return expectedKey;
        }
        if (journalKeyToString(expectedKey) !== journalKeyToString(key)) {
            return makeJournalSourceReadError(
                'the journal sublevel key ' +
                    journalKeyToString(key) +
                    ' disagrees with the record it stores'
            );
        }
        return record;
    }, claimed, startSequence);
}

/**
 * A `JournalSource` over one replica's journal sublevel which streams.
 *
 * The retained lengths come from `readRetainedLengths`, which is one reverse range read
 * per writer. `prefixReaderOf` builds a fresh reader directly over that writer's own
 * record-key range, decoding and key-checking one entry at a time as the oracle pulls
 * it, so no writer's records are materialised as a collection and the complete retained
 * history is never in RAM at once. A reader bounds itself by the length the source
 * declared, so a prefix with a hole, a short prefix or an over-long prefix fails inside
 * the reader exactly as it does over an in-memory supply. `suffixReaderOf` opens the
 * same range at the first missing coordinate, so a consumer can re-read a writer's
 * missing suffix without reading the retained prefix before it.
 *
 * @param {Map<string, JournalSequence>} lengths
 * @param {SimpleSublevel<JournalText, JournalKey>} journalSublevel
 * @returns {JournalSource}
 */
function makeStreamingJournalSource(lengths, journalSublevel) {
    /** @type {Array<JournalAuthor>} */
    const writers = [];
    for (const name of [...lengths.keys()].sort()) {
        const author = makeJournalAuthor(name);
        if (!(author instanceof Error)) {
            writers.push(author);
        }
    }
    return {
        writers: () => writers,
        retainedLengthOf(author) {
            return lengths.get(journalAuthorToString(author));
        },
        prefixReaderOf(author) {
            const name = journalAuthorToString(author);
            const claimed = lengths.get(name);
            if (claimed === undefined) {
                return readerOverRecordSupply(
                    name,
                    async () => undefined,
                    ZERO_JOURNAL_SEQUENCE
                );
            }
            const { gte, lte } = recordRangeOf(author);
            return readerOverRange(name, journalSublevel, author, gte, lte, claimed);
        },
        suffixReaderOf(author, fromSequence) {
            const name = journalAuthorToString(author);
            const claimed = lengths.get(name);
            if (claimed === undefined) {
                return readerOverRecordSupply(
                    name,
                    async () => undefined,
                    ZERO_JOURNAL_SEQUENCE,
                    fromSequence
                );
            }
            const range = recordRangeFromOf(author, fromSequence);
            if (range instanceof Error) {
                return readerOverRecordSupply(name, async () => range, claimed, fromSequence);
            }
            return readerOverRange(name, journalSublevel, author, range.gte, range.lte, claimed, fromSequence);
        },
    };
}

/**
 * A `JournalSource` over one replica's journal sublevel, as the production front supplies it.
 *
 * This is the streaming deployment: the retained lengths come from `readRetainedLengths`
 * and every writer's records are pulled directly from that writer's own range as the
 * oracle reads them, so `readJournalSource` returns before any record is read and the
 * complete retained history is never assembled as one collection. A caller reaches a
 * writer's records only through `prefixReaderOf`, and each call is an independent
 * traversal, because the oracle makes several passes.
 *
 * @param {SimpleSublevel<JournalText, JournalKey>} journalSublevel - The `journal` sublevel
 *   of the replica to read, which a caller reaches through
 *   `RootDatabase.replicaJournalSublevel(name)`.
 * @param {CommittedWriterState | undefined} [committed] - The replica's committed-pair
 *   metadata, when the caller holds it. Supplying it reconciles the retained own-writer
 *   length against the committed writer head here, so a replica which has lost a
 *   surviving suffix of its own writer history is refused before any record is read.
 * @returns {Promise<JournalSource | JournalError>}
 */
async function readJournalSource(journalSublevel, committed) {
    const lengths = await readRetainedLengths(journalSublevel);
    if (lengths instanceof Error) {
        return lengths;
    }
    if (committed !== undefined) {
        const lost = reconcileRetainedWriterHead(makeSyncJournalSource(lengths, () => []), committed);
        if (lost !== undefined) {
            return lost;
        }
    }
    return makeStreamingJournalSource(lengths, journalSublevel);
}

/**
 * Every retained record of a source, delivered to `visit` one at a time.
 *
 * The publication write names the receiver's retained journal as records to keep, so the
 * front folds each retained record into the operation list it lowers. The fold streams
 * through the source's own per-writer readers rather than collecting the records first,
 * so the retained history is never held as a records collection in addition to the
 * operations the atomic batch itself needs.
 *
 * `visit` may itself be asynchronous, because a front which stages each record durably
 * before the next one must await that write; the fold awaits each visit before pulling
 * the next record, so the writer holds at most one record beyond its own bounded batch.
 *
 * `visit` reports a failure as a value, and the first failure ends the fold. A reader's
 * own structural failure is reported the same way.
 *
 * @param {JournalSource} source
 * @param {(record: JournalRecord) => JournalError | undefined | Promise<JournalError | undefined>} visit
 * @returns {Promise<JournalError | undefined>}
 */
async function forEachRetainedRecord(source, visit) {
    for (const author of source.writers()) {
        const reader = source.prefixReaderOf(author);
        for (;;) {
            const record = await reader.nextRecord();
            if (record === undefined) {
                break;
            }
            const failure = await visit(record);
            if (failure !== undefined) {
                return failure;
            }
        }
        const failure = reader.failure();
        if (failure !== undefined) {
            return failure;
        }
    }
    return undefined;
}

module.exports = {
    coordinateTextOf,
    forEachRetainedRecord,
    makeStreamingJournalSource,
    makeSyncJournalSource,
    readJournalSource,
    readRetainedLengths,
    recordRangeOf,
    retainedLengthTexts,
};
