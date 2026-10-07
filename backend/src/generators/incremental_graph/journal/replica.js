/**
 * The retained in-memory Journal replica.
 *
 * A replica is a map from writer to that writer's retained stream, in
 * writer-stream order. It is the input every well-formedness rule is checked
 * against, and it is deliberately immutable: a rule never repairs a replica.
 */

const { makeJournalRecordValidationError } = require("./errors");
const {
    isJournalAuthor,
    isSameJournalAuthor,
    journalAuthorToString,
    journalSequenceToString,
    makeJournalAuthor,
    makeJournalFrontier,
    makeJournalSequence,
    compareJournalSequence,
} = require("./types");
const { isJournalRecord, isSemanticEvent } = require("./records");

/** @typedef {import('./errors').AnyJournalError} JournalError */
/** @typedef {import('./records').JournalRecord} JournalRecord */
/** @typedef {import('./records').SemanticEvent} SemanticEvent */
/** @typedef {import('./types').JournalAuthor} JournalAuthor */
/** @typedef {import('./types').JournalFrontier} JournalFrontier */
/** @typedef {import('./types').JournalSequence} JournalSequence */

/**
 * The properties that this class carries are:
 * - every key is a `JournalAuthor`;
 * - every writer is named by exactly one key, so two keys which denote the same
 *   writer cannot both exist;
 * - every value is a frozen array of current-format `JournalRecord`s stored in
 *   writer-stream order with strictly increasing sequences;
 * - every stored record's `id.author` is the key its stream is stored under;
 * - lookup is by writer identity, not by object identity: `get` and `has`
 *   resolve an author which is equal by name to the stored key, so two
 *   separately constructed authors for one writer name one stream;
 * - the replica cannot be mutated, so every retained value of this type
 *   describes one immutable retained history.
 *
 * The proof of those properties is guaranteed by:
 * - `makeJournalReplica(streams)`: rejects a non-author key, a writer which is
 *   already named by an earlier stream, a record which is not a current-format
 *   record, a record stored under the wrong writer, and a stream whose sequences
 *   do not strictly increase; it stores frozen arrays into a
 *   `JournalReplicaClass`, whose mutating `Map` methods throw.
 * - `joinReplicaRecords(a, b)`: builds its result with `makeJournalReplica`.
 *
 * Writer names are compared by value, not by object identity, so a duplicate
 * writer is rejected here rather than surviving as two distinct `Map` keys which
 * every writer-name comparison would then have to rediscover. A frontier built
 * from such a replica is a frontier which cannot be built at all, so admitting
 * the replica would turn a malformed input into a failure at the first read.
 *
 * Contiguity of a stream is deliberately *not* established here: a hole is a
 * `JournalGapError` which `well_formedness.js` reports, so a fixture can be
 * built and then rejected.
 *
 * @extends {Map<JournalAuthor, ReadonlyArray<JournalRecord>>}
 */
class JournalReplicaClass extends Map {
    constructor() {
        super();
        Object.freeze(this);
    }
    /**
     * @param {unknown} key
     * @returns {ReadonlyArray<JournalRecord> | undefined}
     */
    get(key) {
        if (isJournalAuthor(key)) {
            const direct = Map.prototype.get.call(this, key);
            if (direct !== undefined) {
                return direct;
            }
            for (const entry of this) {
                if (isSameJournalAuthor(entry[0], key)) {
                    return entry[1];
                }
            }
        }
        return undefined;
    }
    /**
     * @param {unknown} key
     * @returns {boolean}
     */
    has(key) {
        return this.get(key) !== undefined;
    }
    /**
     * @returns {never}
     */
    set() {
        throw new Error("JournalReplica is immutable");
    }
    /**
     * @returns {never}
     */
    delete() {
        throw new Error("JournalReplica is immutable");
    }
    /**
     * @returns {never}
     */
    clear() {
        throw new Error("JournalReplica is immutable");
    }
}

/** @typedef {JournalReplicaClass} JournalReplica */

/**
 * @param {unknown} value
 * @returns {value is JournalReplica}
 */
function isJournalReplica(value) {
    return value instanceof JournalReplicaClass;
}

/**
 * @param {Iterable<[JournalAuthor | string, ReadonlyArray<JournalRecord>]>} streams
 * @returns {JournalReplica | JournalError}
 */
function makeJournalReplica(streams) {
    /** @type {Array<[JournalAuthor, ReadonlyArray<JournalRecord>]>} */
    const stored = [];
    /** @type {Set<string>} */
    const namedWriters = new Set();
    for (const stream of streams) {
        const author = isJournalAuthor(stream[0]) ? stream[0] : makeJournalAuthor(stream[0]);
        if (!isJournalAuthor(author)) {
            return makeJournalRecordValidationError(
                "replica stream key is not a journal author",
                "unknown"
            );
        }
        const label = journalAuthorToString(author);
        if (namedWriters.has(label)) {
            return makeJournalRecordValidationError(
                "replica names one writer twice: " + label,
                "unknown"
            );
        }
        namedWriters.add(label);
        const records = stream[1];
        if (!Array.isArray(records)) {
            return makeJournalRecordValidationError(
                "replica stream is not an array of records",
                label
            );
        }
        /** @type {JournalSequence | undefined} */
        let previous;
        for (const record of records) {
            if (!isJournalRecord(record)) {
                return makeJournalRecordValidationError(
                    "replica stream contains a record which is not a current-format record",
                    label
                );
            }
            if (journalAuthorToString(record.id.author) !== label) {
                return makeJournalRecordValidationError(
                    "replica stream contains a record filed under another writer",
                    label
                );
            }
            if (previous !== undefined && compareJournalSequence(previous, record.id.sequence) >= 0) {
                return makeJournalRecordValidationError(
                    "replica stream is not in strictly increasing writer-stream order",
                    label
                );
            }
            previous = record.id.sequence;
        }
        stored.push([author, Object.freeze(records.slice())]);
    }
    const replica = new JournalReplicaClass();
    for (const stream of stored) {
        Map.prototype.set.call(replica, stream[0], stream[1]);
    }
    return replica;
}

/**
 * The retained stream of one writer, which is empty when the writer is absent.
 * @param {JournalReplica} replica
 * @param {JournalAuthor} author
 * @returns {ReadonlyArray<JournalRecord>}
 */
function streamOf(replica, author) {
    const stream = replica.get(author);
    if (stream !== undefined) {
        return stream;
    }
    for (const entry of replica) {
        if (isSameJournalAuthor(entry[0], author)) {
            return entry[1];
        }
    }
    return [];
}

/**
 * The record at one writer coordinate, which is absent when the coordinate is
 * not retained.
 * @param {JournalReplica} replica
 * @param {JournalAuthor} author
 * @param {JournalSequence} sequence
 * @returns {JournalRecord | undefined}
 */
function recordAtSequence(replica, author, sequence) {
    for (const record of streamOf(replica, author)) {
        if (compareJournalSequence(record.id.sequence, sequence) === 0) {
            return record;
        }
    }
    return undefined;
}

/**
 * The records of one writer through one coordinate, in writer-stream order.
 * @param {JournalReplica} replica
 * @param {JournalAuthor} author
 * @param {JournalSequence} sequence
 * @returns {Array<JournalRecord>}
 */
function recordsUpToSequence(replica, author, sequence) {
    const included = [];
    for (const record of streamOf(replica, author)) {
        if (compareJournalSequence(record.id.sequence, sequence) <= 0) {
            included.push(record);
        }
    }
    return included;
}

/**
 * The semantic events of one writer through one coordinate. A non-semantic
 * record between two semantic events does not affect the relation, so only the
 * semantic events matter to a context check.
 * @param {JournalReplica} replica
 * @param {JournalAuthor} author
 * @param {JournalSequence} sequence
 * @returns {Array<SemanticEvent>}
 */
function semanticEventsUpToSequence(replica, author, sequence) {
    return recordsUpToSequence(replica, author, sequence).filter((record) =>
        isSemanticEvent(record)
    );
}

/**
 * The retained frontier of a replica: the greatest retained coordinate of each
 * writer.
 *
 * `makeJournalReplica` already rejected a writer named twice, so these
 * coordinates name distinct writers and `makeJournalFrontier` accepts them. The
 * throw below is a defect report for this module's own literals, not a path a
 * `JournalReplica` can reach.
 * @param {JournalReplica} replica
 * @returns {JournalFrontier}
 */
function replicaFrontier(replica) {
    /** @type {Array<[JournalAuthor, JournalSequence]>} */
    const entries = [];
    for (const stream of replica) {
        const records = stream[1];
        const last = records[records.length - 1];
        if (last === undefined) {
            continue;
        }
        entries.push([stream[0], last.id.sequence]);
    }
    const frontier = makeJournalFrontier(entries);
    if (frontier instanceof Error) {
        throw new Error("replicaFrontier read a coordinate the replica did not create");
    }
    return frontier;
}

/**
 * Every semantic event in the replica, in no particular order. Callers which
 * need writer-stream order iterate streams instead.
 * @param {JournalReplica} replica
 * @returns {Array<SemanticEvent>}
 */
function semanticEventsOfReplica(replica) {
    /** @type {Array<SemanticEvent>} */
    const events = [];
    for (const stream of replica) {
        for (const record of stream[1]) {
            if (isSemanticEvent(record)) {
                events.push(record);
            }
        }
    }
    return events;
}

module.exports = {
    isJournalReplica,
    isSameJournalAuthor,
    journalSequenceToString,
    makeJournalReplica,
    makeJournalSequence,
    recordAtSequence,
    recordsUpToSequence,
    replicaFrontier,
    semanticEventsOfReplica,
    semanticEventsUpToSequence,
    streamOf,
};
