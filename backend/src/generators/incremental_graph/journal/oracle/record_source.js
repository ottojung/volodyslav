/**
 * The streaming record source the oracle reads.
 *
 * The oracle never receives a `JournalReplica`. It receives a `JournalSource`,
 * which exposes one writer's retained prefix at a time as a pull reader, plus
 * that writer's retained length. That is the shape a per-writer range iterator
 * over the Journal sublevel has, so a future persistence front can supply the
 * oracle without changing it.
 *
 * A source may be a prefix *union* of several retained prefixes, and the union
 * is performed by a streaming merge. The two structural journal properties fall
 * out of that merge rather than being checked by a separate pass over history:
 *
 * - **no holes.** Every reader holds the coordinate it expects next and admits
 *   only the record at exactly that coordinate, bounded by the retained length
 *   the source declares. A prefix which skips a coordinate fails at that
 *   coordinate, because the counter is the only thing which admits a record. A
 *   separate contiguity scan would be a second traversal of the same records to
 *   learn something the reader already knows while producing them.
 * - **no forks.** Two contributors which both supply one coordinate are compared
 *   by canonical current-format meaning at the moment the merge admits that
 *   coordinate, so disagreement is reported without rescanning the historical
 *   overlap.
 *
 * Neither property is asserted by the oracle. Each is a consequence of the
 * reader, and a fixture which violates either one fails inside the reader.
 */

const {
    makeJournalForkError,
    makeJournalGapError,
    makeJournalRecordValidationError,
} = require("../errors");
const { encodeJournalRecord } = require("../codec");
const { isJournalRecord } = require("../records");
const {
    compareJournalSequence,
    isSameJournalAuthor,
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceToString,
    makeJournalSequence,
    ZERO_JOURNAL_SEQUENCE,
} = require("../types");

/** @typedef {import("../errors").AnyJournalError} JournalError */
/** @typedef {import("../records").JournalRecord} JournalRecord */
/** @typedef {import("../types").JournalAuthor} JournalAuthor */
/** @typedef {import("../types").JournalSequence} JournalSequence */

/**
 * A canonical sequence coordinate, or a thrown defect in this module's own
 * literals.
 *
 * The record layer's `makeJournalSequence` reports a malformed coordinate as an
 * error value, which is right at a record boundary and wrong here: every digit
 * string this module passes is a literal or a decimal successor it computed
 * itself, so a rejection is a bug in the oracle rather than bad input.
 * @param {string} digits
 * @returns {JournalSequence}
 */
function canonicalSequence(digits) {
    const sequence = makeJournalSequence(digits);
    if (sequence instanceof Error) {
        throw new Error("the oracle built a coordinate the canonical pattern rejects: " + digits);
    }
    return sequence;
}

/**
 * A pull reader over one writer's retained records in writer-stream order.
 *
 * Reading is destructive: `nextRecord` advances. Every pass the oracle makes
 * therefore asks the source for a fresh reader rather than keeping one.
 *
 * @typedef {object} PrefixReader
 * @property {() => JournalRecord | undefined} nextRecord - The next retained
 *   record, or `undefined` at the end of the retained prefix.
 * @property {() => JournalError | undefined} failure - The structural failure
 *   which ended the prefix, or `undefined` while the prefix is intact. A
 *   non-`undefined` failure means the reader delivered a partial prefix, and the
 *   consumer must not treat it as a whole one.
 */

/**
 * A re-readable source of retained journal records, one writer prefix at a time.
 *
 * Every method is per writer. There is deliberately no method which returns the
 * complete retained journal, every writer's history at once, or one node's
 * history as a collection, so a caller cannot reintroduce whole-journal
 * materialisation through this interface.
 *
 * @typedef {object} JournalSource
 * @property {() => ReadonlyArray<JournalAuthor>} writers - The writers with a
 *   retained prefix, in ascending author order.
 * @property {(author: JournalAuthor) => JournalSequence | undefined} retainedLengthOf -
 *   The greatest retained coordinate of one writer, or `undefined` when the
 *   writer is absent. A writer's length is one constant-size read, not a scan.
 * @property {(author: JournalAuthor) => PrefixReader} prefixReaderOf - A fresh
 *   reader over one writer's retained records in writer-stream order. Each call
 *   is an independent traversal, because the oracle makes several passes.
 */

/**
 * The canonical decimal successor of a coordinate.
 *
 * The oracle walks `A:1 .. A:q`, and a sequence coordinate is arbitrary
 * precision, so the successor is decimal string arithmetic on canonical digits.
 * It is deliberately not a `number` and not a `BigInt`: a `number` would lose
 * precision above 2^53, and `BigInt` is not available at this module's
 * compilation target.
 * @param {JournalSequence} sequence
 * @returns {JournalSequence}
 */
function successorJournalSequence(sequence) {
    const digits = journalSequenceToString(sequence).split("");
    let index = digits.length - 1;
    while (index >= 0) {
        const nextDigit = Number(digits[index]) + 1;
        digits[index] = String(nextDigit % 10);
        if (nextDigit < 10) {
            break;
        }
        index--;
    }
    const incremented = index < 0 ? "1" + digits.join("") : digits.join("");
    return canonicalSequence(incremented);
}

/**
 * @param {JournalRecord} record
 * @param {string} authorName
 * @returns {JournalError | undefined}
 */
function validateContributorRecord(record, authorName) {
    if (!isJournalRecord(record)) {
        return makeJournalRecordValidationError(
            "a retained prefix contains a value which is not a current-format record",
            authorName
        );
    }
    if (journalAuthorToString(record.id.author) !== authorName) {
        return makeJournalRecordValidationError(
            "a retained prefix contains a record filed under another writer",
            journalRecordIdToString(record.id)
        );
    }
    return undefined;
}

/**
 * A reader over one writer's retained records which decides the no-holes
 * condition as it goes.
 *
 * The declared retained length bounds the walk in both directions, so a prefix
 * which skips a coordinate and a prefix which ends before the length it claims
 * are both failures rather than being silently accepted as a whole prefix.
 * @param {string} authorName
 * @param {Iterable<JournalRecord>} iterable
 * @param {JournalSequence} claimedLength
 * @returns {PrefixReader}
 */
function readerOverIterable(authorName, iterable, claimedLength) {
    const iterator = iterable[Symbol.iterator]();
    let expected = canonicalSequence("1");
    let lastRead = ZERO_JOURNAL_SEQUENCE;
    /** @type {JournalError | undefined} */
    let failure;

    /**
     * @param {string} missingSequence
     * @returns {JournalError}
     */
    function gapAt(missingSequence) {
        return makeJournalGapError(
            authorName,
            journalSequenceToString(claimedLength),
            missingSequence
        );
    }

    /**
     * @returns {JournalRecord | undefined}
     */
    function admit() {
        const step = iterator.next();
        if (step.done === true) {
            if (compareJournalSequence(lastRead, claimedLength) < 0) {
                failure = gapAt(journalSequenceToString(expected));
            }
            return undefined;
        }
        const record = step.value;
        const invalid = validateContributorRecord(record, authorName);
        if (invalid !== undefined) {
            failure = invalid;
            return undefined;
        }
        const position = compareJournalSequence(record.id.sequence, expected);
        if (position < 0) {
            failure = makeJournalRecordValidationError(
                "a retained prefix is not in strictly increasing writer-stream order",
                journalRecordIdToString(record.id)
            );
            return undefined;
        }
        if (position > 0) {
            failure = gapAt(journalSequenceToString(expected));
            return undefined;
        }
        lastRead = expected;
        expected = successorJournalSequence(expected);
        return record;
    }

    return {
        nextRecord: () => (failure === undefined ? admit() : undefined),
        failure: () => failure,
    };
}

/**
 * A cursor with one record of lookahead over a pull function.
 * @param {() => JournalRecord | undefined} next
 * @returns {{peek: () => JournalRecord | undefined, advance: () => void}}
 */
function makeCursor(next) {
    /** @type {JournalRecord | undefined} */
    let buffered;
    let exhausted = false;
    return {
        peek() {
            if (buffered !== undefined || exhausted) {
                return buffered;
            }
            const record = next();
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
 * @returns {{cursor: {peek: () => JournalRecord | undefined, advance: () => void}, failureOf: () => JournalError | undefined}}
 */
function cursorOverReader(reader) {
    /** @type {JournalError | undefined} */
    let contributorFailure;
    const cursor = makeCursor(() => {
        if (contributorFailure !== undefined) {
            return undefined;
        }
        const record = reader.nextRecord();
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
     * @returns {JournalRecord | undefined}
     */
    function admitAtExpectedCoordinate() {
        /** @type {JournalRecord[]} */
        const atCoordinate = [];
        for (const contributor of admitted) {
            const head = contributor.cursor.peek();
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
        nextRecord() {
            if (failure !== undefined) {
                return undefined;
            }
            const record = admitAtExpectedCoordinate();
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
    readerOverIterable,
    successorJournalSequence,
};
