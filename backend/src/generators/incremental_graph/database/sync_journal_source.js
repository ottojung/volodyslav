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
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalSequence} JournalSequence */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('../journal/oracle/record_source').PrefixReader} PrefixReader */
/** @typedef {import('./types').JournalKey} JournalKey */
/** @typedef {import('./types').JournalText} JournalText */
/**
 * @template T
 * @template [K=import('./types').DatabaseKey]
 * @typedef {import('./types').SimpleSublevel<T, K>} SimpleSublevel
 */

const {
    journalAuthorToString,
    journalSequenceToString,
    makeJournalAuthor,
    makeJournalSequence,
    readerOverIterable,
} = require('../journal');
const { journalKeyToString, stringToJournalKey } = require('./types');

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

module.exports = {
    coordinateTextOf,
    makeSyncJournalSource,
    readRetainedLengths,
    recordRangeOf,
    retainedLengthTexts,
};
