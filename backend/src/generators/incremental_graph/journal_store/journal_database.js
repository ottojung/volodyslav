/**
 * The Journal sublevel layout: how a finalized publication becomes database operations.
 *
 * A publication is durable only if its records land in the SAME atomic write as the
 * graph mutations they describe. This module is the pure key/operation half of that
 * requirement: it names the Journal's keys, turns a `FinalizedPublication` into
 * `putOp`s of the very shape the graph sublevels contribute, and reads the Journal's
 * own committed-pair metadata and current value occurrences back out of the sublevel.
 *
 * The Journal lives in the replica's `journal` sublevel, which participates in the
 * same LevelDB batch as `values`, `freshness`, `valid`, `timestamps` and `global`.
 * The layout inside that sublevel is three key families:
 *
 * ```text
 * state                                the Journal committed-pair metadata record
 * record|<author>|<padded coordinate>  one canonical current-format record per key
 * occurrence|<sha256(canonical node key)>  JSON node/record-id occurrence metadata
 * ```
 *
 * The coordinate is left-padded to a fixed width so that a plain byte-ordered
 * iteration of the sublevel yields each writer's records in writer-stream order
 * without a numeric decode. The record's own text keeps the canonical unpadded
 * coordinate, so padding is a storage concern only.
 *
 * The committed-pair metadata is the Journal side of the pair the publication
 * advances: local writer, writer head, committed frontier, authority high-water and
 * allocator watermark. `incremental-graph-journal-storage.md` §Committed-pair
 * metadata requires it to be published atomically with the records, which is why it
 * is written as one of the publication's operations rather than afterwards.
 */

/** @typedef {import("../journal/errors").AnyJournalError} JournalError */
/** @typedef {import("../journal/records").JournalRecord} JournalRecord */
/** @typedef {import("../journal/replica").JournalReplica} JournalReplica */
/** @typedef {import("../journal/emission").CommittedWriterState} CommittedWriterState */
/** @typedef {import("../journal/emission").FinalizedPublication} FinalizedPublication */
/** @typedef {import("../journal/types").AuthorityTime} AuthorityTime */
/** @typedef {import("../journal/types").JournalAuthor} JournalAuthor */
/** @typedef {import("../database/node_key").NodeKey} NodeKey */
/** @typedef {import("../journal/types").JournalFrontier} JournalFrontier */
/** @typedef {import("../journal/types").JournalRecordId} JournalRecordId */
/** @typedef {import("../journal/types").JournalSequence} JournalSequence */
/** @typedef {import("../database/types").DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import("../database/types").JournalKey} JournalKey */
/** @typedef {import("../database/root_database").JournalDatabase} JournalDatabase */
/** @typedef {import("../journal_retained").RetainedReplayState} RetainedReplayState */

const {
    encodeJournalRecord,
    isDeleteEvent,
    isValueEvent,
    journalAuthorToString,
    journalSequenceToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontier,
    makeJournalPublicationError,
    makeJournalSourceReadError,
    makeJournalReplica,
    makeJournalSequence,
    makeReplicaSource,
    tryDecodeJournalRecord,
    ZERO_JOURNAL_SEQUENCE,
} = require("../journal");
const {
    checkOccurrenceIndexCollisions,
    decodeJournalOccurrenceText,
    makeJournalOccurrenceKey,
    makeJournalOccurrenceText,
    readCurrentOccurrence,
} = require("./occurrence_index");
const { reconcileRetainedWriterHead } = require("./writer_head");
const { appendRetainedStateOp } = require("./retained_state");
const {
    journalKeyToString,
    journalTextToString,
    stringToJournalKey,
    stringToJournalText,
} = require("../database");

/**
 * The one key the Journal's committed-pair metadata occupies.
 */
const JOURNAL_STATE_KEY = stringToJournalKey("state");

const RECORD_KEY_PREFIX = "record|";

/**
 * The fixed width every record coordinate is padded to inside the sublevel key.
 * A coordinate longer than this cannot be published through this sublevel.
 */
const RECORD_KEY_DIGITS = 30;

/**
 * The storage key one record occupies.
 * @param {JournalAuthor} author
 * @param {JournalSequence} sequence
 * @returns {JournalKey | JournalError}
 */
function makeJournalRecordKey(author, sequence) {
    const digits = journalSequenceToString(sequence);
    if (digits.length > RECORD_KEY_DIGITS) {
        return makeJournalPublicationError(
            "a journal coordinate of " + digits.length + " digits exceeds the " +
                RECORD_KEY_DIGITS + "-digit storage key width"
        );
    }
    return stringToJournalKey(
        RECORD_KEY_PREFIX + journalAuthorToString(author) + "|" + digits.padStart(RECORD_KEY_DIGITS, "0")
    );
}

/**
 * @param {CommittedWriterState} state
 * @returns {object}
 */
function serializeWriterState(state) {
    return {
        localWriter: journalAuthorToString(state.localWriter),
        writerHead: journalSequenceToString(state.writerHead),
        committedFrontier: [...state.committedFrontier].map((coordinate) => [
            journalAuthorToString(coordinate[0]),
            journalSequenceToString(coordinate[1]),
        ]),
        authorityHighWater: [
            state.authorityHighWater.physical,
            journalSequenceToString(state.authorityHighWater.logical),
        ],
        allocatorWatermark: state.allocatorWatermark,
    };
}

/**
 * @param {unknown} value
 * @param {string} fingerprint
 * @returns {CommittedWriterState | JournalError}
 */
function deserializeWriterState(value, fingerprint) {
    if (
        typeof value !== "object" ||
        value === null ||
        !("localWriter" in value) ||
        !("writerHead" in value) ||
        !("committedFrontier" in value) ||
        !("authorityHighWater" in value) ||
        !("allocatorWatermark" in value)
    ) {
        return makeJournalSourceReadError("the journal state record is missing a required field");
    }
    if (typeof value.localWriter !== "string" || value.localWriter !== fingerprint) {
        return makeJournalSourceReadError(
            "the journal state record names writer " + JSON.stringify(value.localWriter) +
                " but this database's fingerprint is " + JSON.stringify(fingerprint)
        );
    }
    const localWriter = makeJournalAuthor(value.localWriter);
    if (localWriter instanceof Error) {
        return localWriter;
    }
    if (typeof value.writerHead !== "string") {
        return makeJournalSourceReadError("the journal state record has no writer head");
    }
    const writerHead = makeJournalSequence(value.writerHead);
    if (writerHead instanceof Error) {
        return writerHead;
    }
    if (!Array.isArray(value.committedFrontier)) {
        return makeJournalSourceReadError("the journal state record has no committed frontier");
    }
    /** @type {Array<[JournalAuthor, JournalSequence]>} */
    const entries = [];
    for (const entry of value.committedFrontier) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
            return makeJournalSourceReadError("the journal state record has a malformed committed frontier entry");
        }
        const author = makeJournalAuthor(entry[0]);
        if (author instanceof Error) {
            return author;
        }
        const sequence = makeJournalSequence(entry[1]);
        if (sequence instanceof Error) {
            return sequence;
        }
        entries.push([author, sequence]);
    }
    const committedFrontier = makeJournalFrontier(entries);
    if (committedFrontier instanceof Error) {
        return committedFrontier;
    }
    if (!Array.isArray(value.authorityHighWater) || value.authorityHighWater.length !== 2) {
        return makeJournalSourceReadError("the journal state record has no authority high-water");
    }
    const physical = value.authorityHighWater[0];
    const logical = value.authorityHighWater[1];
    if (typeof physical !== "number" || typeof logical !== "string") {
        return makeJournalSourceReadError("the journal state record has a malformed authority high-water");
    }
    const authorityHighWater = makeAuthorityTime(physical, logical);
    if (authorityHighWater instanceof Error) {
        return authorityHighWater;
    }
    if (typeof value.allocatorWatermark !== "number" || !Number.isSafeInteger(value.allocatorWatermark)) {
        return makeJournalSourceReadError("the journal state record has a malformed allocator watermark");
    }
    return {
        localWriter,
        writerHead,
        committedFrontier,
        authorityHighWater,
        allocatorWatermark: value.allocatorWatermark,
    };
}

/**
 * The committed Journal state a database which has published nothing yet starts from.
 * @param {JournalAuthor} localWriter
 * @returns {CommittedWriterState | JournalError}
 */
function makeInitialCommittedWriterState(localWriter) {
    const committedFrontier = makeJournalFrontier([]);
    if (committedFrontier instanceof Error) {
        return committedFrontier;
    }
    const authorityHighWater = makeAuthorityTime(0, "0");
    if (authorityHighWater instanceof Error) {
        return authorityHighWater;
    }
    return {
        localWriter,
        writerHead: ZERO_JOURNAL_SEQUENCE,
        committedFrontier,
        authorityHighWater,
        allocatorWatermark: 0,
    };
}

/**
 * Read the Journal's committed-pair metadata out of the sublevel.
 *
 * A database with no state record has published nothing, which is the initial
 * committed state rather than a defect.
 *
 * @param {JournalDatabase} journalDatabase
 * @param {string} fingerprint - This database's fingerprint, which is the local writer name.
 * @returns {Promise<CommittedWriterState | JournalError>}
 */
async function readCommittedWriterState(journalDatabase, fingerprint) {
    const raw = await journalDatabase.get(JOURNAL_STATE_KEY);
    if (raw === undefined) {
        const author = makeJournalAuthor(fingerprint);
        if (author instanceof Error) {
            return author;
        }
        return makeInitialCommittedWriterState(author);
    }
    return deserializeWriterState(JSON.parse(journalTextToString(raw)), fingerprint);
}

/**
 * Append one finalized publication to `operations`.
 *
 * Every record, every current-occurrence update the publication implies, the
 * publication's committed-pair metadata, and — when the caller supplies it — the
 * retained replay state which describes the resulting journal become operations of the
 * caller's array, so the caller publishes them in the same atomic write as the graph
 * mutations they describe. It reads the current index to reject collisions,
 * but performs no writes until the caller publishes the finished batch.
 *
 * @param {JournalDatabase} journalDatabase
 * @param {Array<DatabaseBatchOperation>} operations
 * @param {FinalizedPublication} publication
 * @param {RetainedReplayState | undefined} [retainedState] - The summary which
 *   describes the journal after this publication. When supplied it is persisted in
 *   the same batch, which is what makes the active summary durable with the pair.
 * @returns {Promise<JournalError | undefined>}
 */
async function appendJournalPublicationOps(journalDatabase, operations, publication, retainedState) {
    const collision = await checkOccurrenceIndexCollisions(journalDatabase, publication.records);
    if (collision !== undefined) {
        return collision;
    }
    for (const record of publication.records) {
        const key = makeJournalRecordKey(record.id.author, record.id.sequence);
        if (key instanceof Error) {
            return key;
        }
        operations.push(journalDatabase.putOp(key, stringToJournalText(encodeJournalRecord(record))));
    }
    for (const record of publication.records) {
        if (isValueEvent(record)) {
            operations.push(
                journalDatabase.putOp(
                    makeJournalOccurrenceKey(record.node),
                    makeJournalOccurrenceText(record.node, record.id)
                )
            );
            continue;
        }
        if (isDeleteEvent(record)) {
            operations.push(journalDatabase.delOp(makeJournalOccurrenceKey(record.node)));
        }
    }
    operations.push(
        journalDatabase.putOp(
            JOURNAL_STATE_KEY,
            stringToJournalText(JSON.stringify(serializeWriterState(publication.writerState)))
        )
    );
    if (retainedState !== undefined) {
        const rejected = appendRetainedStateOp(journalDatabase, operations, retainedState);
        if (rejected !== undefined) {
            return rejected;
        }
    }
    return undefined;
}

/**
 * Read every retained record back, grouped by writer in writer-stream order, through
 * the same current-format reader the filesystem record store uses.
 *
 * When the caller supplies the database's committed-pair metadata, the retained
 * own-writer length is reconciled against the committed writer head before the replica
 * is returned, so a database which has lost a surviving suffix of its own writer
 * history is refused rather than replayed.
 *
 * @param {JournalDatabase} journalDatabase
 * @param {CommittedWriterState | undefined} [committed] - The database's committed-pair
 *   metadata, when the caller holds it.
 * @returns {Promise<JournalReplica | JournalError>}
 */
async function readRetainedJournal(journalDatabase, committed) {
    /** @type {Map<string, {author: JournalAuthor, records: Array<JournalRecord>}>} */
    const byAuthor = new Map();
    for await (const journalKey of journalDatabase.keys()) {
        const key = journalKeyToString(journalKey);
        if (!key.startsWith(RECORD_KEY_PREFIX)) {
            continue;
        }
        const separator = key.indexOf("|", RECORD_KEY_PREFIX.length);
        if (separator < 0) {
            return makeJournalSourceReadError("the journal sublevel holds a malformed record key " + key);
        }
        const authorText = key.slice(RECORD_KEY_PREFIX.length, separator);
        const text = await journalDatabase.get(journalKey);
        if (text === undefined) {
            return makeJournalSourceReadError("the journal sublevel key " + key + " has no stored record");
        }
        const record = tryDecodeJournalRecord(journalTextToString(text));
        if (record instanceof Error) {
            return record;
        }
        const author = makeJournalAuthor(authorText);
        if (author instanceof Error) {
            return author;
        }
        const expectedKey = makeJournalRecordKey(author, record.id.sequence);
        if (expectedKey instanceof Error || journalKeyToString(expectedKey) !== key) {
            return expectedKey instanceof Error
                ? expectedKey
                : makeJournalSourceReadError(
                    "the journal sublevel key " + key + " disagrees with the record it stores"
                );
        }
        const stream = byAuthor.get(authorText);
        if (stream === undefined) {
            byAuthor.set(authorText, { author, records: [record] });
        } else {
            stream.records.push(record);
        }
    }
    /** @type {Array<[JournalAuthor, Array<JournalRecord>]>} */
    const streams = [];
    for (const authorText of [...byAuthor.keys()].sort()) {
        const stream = byAuthor.get(authorText);
        if (stream !== undefined) {
            streams.push([stream.author, stream.records]);
        }
    }
    const replica = makeJournalReplica(streams);
    if (replica instanceof Error) {
        return makeJournalSourceReadError("the journal sublevel could not assemble a retained replica: " + replica.message);
    }
    if (committed !== undefined) {
        const lost = reconcileRetainedWriterHead(makeReplicaSource(replica), committed);
        if (lost !== undefined) {
            return lost;
        }
    }
    return replica;
}

module.exports = {
    JOURNAL_STATE_KEY,
    appendJournalPublicationOps,
    appendRetainedStateOp,
    deserializeWriterState,
    makeInitialCommittedWriterState,
    makeJournalOccurrenceKey,
    makeJournalOccurrenceText,
    decodeJournalOccurrenceText,
    makeJournalRecordKey,
    readCommittedWriterState,
    readCurrentOccurrence,
    readRetainedJournal,
    serializeWriterState,
};
