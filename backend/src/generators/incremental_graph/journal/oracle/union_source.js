/**
 * The prefix-union sources the oracle is handed when a caller holds history in
 * memory or deliberately presents a fork or a hole.
 *
 * `record_source.js` owns the per-writer reader and the no-holes decision. This
 * module owns the two `JournalSource` shapes built on top of it: one already
 * materialised replica, and the streaming prefix union of several sources. Both
 * consume their contributors through the same asynchronous `PrefixReader`
 * interface, so a union of a durable source and an in-memory one is one merge.
 */

const { encodeJournalRecord } = require("../codec");
const {
    makeJournalForkError,
    makeJournalRecordValidationError,
} = require("../errors");
const {
    compareJournalSequence,
    isSameJournalAuthor,
    journalAuthorToString,
    journalRecordIdToString,
    ZERO_JOURNAL_SEQUENCE,
} = require("../types");
const {
    canonicalSequence,
    readerOverIterable,
    successorJournalSequence,
    validateContributorRecord,
} = require("./record_source");

/** @typedef {import("../errors").AnyJournalError} JournalError */
/** @typedef {import("../records").JournalRecord} JournalRecord */
/** @typedef {import("../types").JournalAuthor} JournalAuthor */
/** @typedef {import("../types").JournalSequence} JournalSequence */
/** @typedef {import("./record_source").JournalSource} JournalSource */
/** @typedef {import("./record_source").PrefixReader} PrefixReader */

/**
 * A cursor with one record of lookahead over an asynchronous pull function.
 * @param {() => Promise<JournalRecord | undefined>} next
 * @returns {{peek: () => Promise<JournalRecord | undefined>, advance: () => void}}
 */
function makeCursor(next) {
    /** @type {JournalRecord | undefined} */
    let buffered;
    let exhausted = false;
    return {
        async peek() {
            if (buffered !== undefined || exhausted) {
                return buffered;
            }
            const record = await next();
            if (record === undefined) {
                exhausted = true;
                return undefined;
            }
            buffered = record;
            return record;
        },
        advance() {
            buffered = undefined;
        },
    };
}

/**
 * One contributor to a prefix union, read through its own reader so that a
 * contributor's own structural failure reaches the merge instead of being
 * swallowed by it.
 *
 * A failed contributor stops contributing and reports through `failureOf`, so a
 * caller's error is returned through the reader's own error channel rather than
 * thrown past it. A `PrefixReader` is an error-as-value boundary, and a union of
 * readers which threw would break that for every consumer of the union.
 * @param {PrefixReader} reader
 * @returns {{cursor: {peek: () => Promise<JournalRecord | undefined>, advance: () => void}, failureOf: () => JournalError | undefined}}
 */
function cursorOverReader(reader) {
    /** @type {JournalError | undefined} */
    let contributorFailure;
    const cursor = makeCursor(async () => {
        if (contributorFailure !== undefined) {
            return undefined;
        }
        const record = await reader.nextRecord();
        if (record === undefined) {
            contributorFailure = reader.failure();
        }
        return record;
    });
    return { cursor, failureOf: () => contributorFailure };
}

/**
 * A reader over the streaming prefix union of several retained prefixes of one
 * writer.
 *
 * The merge is driven by an expected coordinate. A contributor whose next record
 * is beyond that coordinate waits. Agreement between contributors is decided
 * where they meet, so the merge is the only place which needs the canonical
 * meaning of a record.
 * @param {string} authorName
 * @param {ReadonlyArray<PrefixReader>} contributors
 * @returns {PrefixReader}
 */
function mergePrefixUnion(authorName, contributors) {
    const admitted = contributors.map((contributor) => cursorOverReader(contributor));
    let expected = canonicalSequence("1");
    /** @type {JournalError | undefined} */
    let failure;

    /**
     * Collect every contributor's record at the expected coordinate, or report
     * the failure which prevents one.
     * @returns {Promise<JournalRecord | undefined>}
     */
    async function admitAtExpectedCoordinate() {
        /** @type {JournalRecord[]} */
        const atCoordinate = [];
        for (const contributor of admitted) {
            const head = await contributor.cursor.peek();
            if (head === undefined) {
                const contributorFailure = contributor.failureOf();
                if (contributorFailure !== undefined) {
                    failure = contributorFailure;
                    return undefined;
                }
                continue;
            }
            const invalid = validateContributorRecord(head, authorName);
            if (invalid !== undefined) {
                failure = invalid;
                return undefined;
            }
            const position = compareJournalSequence(head.id.sequence, expected);
            if (position < 0) {
                failure = makeJournalRecordValidationError(
                    "a retained prefix is not in strictly increasing writer-stream order",
                    journalRecordIdToString(head.id)
                );
                return undefined;
            }
            if (position > 0) {
                continue;
            }
            atCoordinate.push(head);
            contributor.cursor.advance();
        }
        const first = atCoordinate[0];
        if (first === undefined) {
            // Every contributor is a `PrefixReader` which bounds itself by the
            // length its own source declares, so a contributor which ends has
            // already reported its own shortfall there. The union therefore never
            // falls short of the greatest declared length on its own, and an
            // exhausted merge is not by itself evidence of a hole.
            return undefined;
        }
        const meaning = encodeJournalRecord(first);
        for (const other of atCoordinate.slice(1)) {
            if (encodeJournalRecord(other) !== meaning) {
                failure = makeJournalForkError(
                    journalRecordIdToString(first.id),
                    meaning,
                    encodeJournalRecord(other)
                );
                return undefined;
            }
        }
        return first;
    }

    return {
        async nextRecord() {
            if (failure !== undefined) {
                return undefined;
            }
            const record = await admitAtExpectedCoordinate();
            if (record === undefined) {
                return undefined;
            }
            expected = successorJournalSequence(expected);
            return record;
        },
        failure: () => failure,
    };
}

/**
 * A source backed by one already-materialised replica, for callers which hold
 * history in memory. The oracle consumes it through the same per-writer
 * interface as every other source, so holding a replica is a property of the
 * caller and not of the oracle.
 * @param {import("../replica").JournalReplica} replica
 * @returns {JournalSource}
 */
function makeReplicaSource(replica) {
    const writers = [...replica.keys()].sort((a, b) => {
        const left = journalAuthorToString(a);
        const right = journalAuthorToString(b);
        return left < right ? -1 : left > right ? 1 : 0;
    });
    /**
     * @param {JournalAuthor} author
     * @returns {ReadonlyArray<JournalRecord>}
     */
    function streamOfAuthor(author) {
        const direct = replica.get(author);
        if (direct !== undefined) {
            return direct;
        }
        for (const entry of replica) {
            if (isSameJournalAuthor(entry[0], author)) {
                return entry[1];
            }
        }
        return [];
    }
    return {
        writers: () => writers,
        retainedLengthOf(author) {
            const stream = streamOfAuthor(author);
            const last = stream[stream.length - 1];
            return last === undefined ? undefined : last.id.sequence;
        },
        prefixReaderOf(author) {
            const stream = streamOfAuthor(author);
            const last = stream[stream.length - 1];
            const length = last === undefined ? ZERO_JOURNAL_SEQUENCE : last.id.sequence;
            return readerOverIterable(journalAuthorToString(author), stream, length);
        },
    };
}

/**
 * The prefix union of several sources, merged per writer.
 *
 * This is how the oracle is handed a fork or a hole fixture: a source which is a
 * union of disagreeing retained prefixes is not a supported journal, and the
 * merge reports that rather than the oracle discovering it later.
 * @param {ReadonlyArray<JournalSource>} sources
 * @returns {JournalSource}
 */
function makeUnionSource(sources) {
    /** @type {Map<string, JournalAuthor>} */
    const byName = new Map();
    for (const source of sources) {
        for (const author of source.writers()) {
            const name = journalAuthorToString(author);
            if (!byName.has(name)) {
                byName.set(name, author);
            }
        }
    }
    const writers = [...byName.values()].sort((a, b) => {
        const left = journalAuthorToString(a);
        const right = journalAuthorToString(b);
        return left < right ? -1 : left > right ? 1 : 0;
    });
    /**
     * @param {JournalAuthor} author
     * @returns {ReadonlyArray<JournalSource>}
     */
    function sourcesHolding(author) {
        return sources.filter((source) =>
            source.writers().some((held) => isSameJournalAuthor(held, author))
        );
    }
    /**
     * @param {JournalAuthor} author
     * @returns {JournalSequence}
     */
    function unionLengthOf(author) {
        let greatest = ZERO_JOURNAL_SEQUENCE;
        for (const source of sourcesHolding(author)) {
            const length = source.retainedLengthOf(author);
            if (length !== undefined && compareJournalSequence(length, greatest) > 0) {
                greatest = length;
            }
        }
        return greatest;
    }
    return {
        writers: () => writers,
        retainedLengthOf(author) {
            const length = unionLengthOf(author);
            return compareJournalSequence(length, ZERO_JOURNAL_SEQUENCE) === 0 ? undefined : length;
        },
        prefixReaderOf(author) {
            const contributors = sourcesHolding(author).map((source) =>
                source.prefixReaderOf(author)
            );
            return mergePrefixUnion(journalAuthorToString(author), contributors);
        },
    };
}

module.exports = {
    makeReplicaSource,
    makeUnionSource,
    mergePrefixUnion,
};
