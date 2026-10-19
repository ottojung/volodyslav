/**
 * Foreign-writer suffix import: the acquisition step of synchronization.
 *
 * `incremental-graph-journal-sync.md` §Missing foreign-writer suffixes defines
 * the acquisition as an exact rule over two frontiers: for every writer `A` other
 * than the receiver's own writer whose source length exceeds the receiver's, the
 * receiver imports `A:(FR[A]+1) .. FS[A]` in ascending writer-local sequence
 * order, and every imported record is retained unchanged.
 *
 * This module is the executable form of that rule. It is pure: it reads two
 * `JournalSource`s and returns the imported range of each writer together with
 * the union frontier those records extend, so it performs no I/O, holds no locks
 * and owns no lifecycle.
 *
 * ## Streaming
 *
 * The plan carries no copy of the admitted suffix. Each `ImportedSuffix` names
 * the range `A:(FR[A]+1) .. FS[A]` and exposes a fresh, positioned reader over
 * the held source, so `$id-4924739474925738` holds here: the complete newly
 * transferred suffix is consumed incrementally and is never held as one in-RAM
 * collection. The relation-shaped validation re-reads the change set against a
 * complete admitted-relations index rather than against an admitted-records
 * array, so the only derived state that spans the change set is the index itself.
 *
 * ## What is checked here, and what is not
 *
 * The specification makes the historical overlap of two compatible supported
 * replicas identical (`incremental-graph-journal-theorems.md` Laws 8 and 8a), so
 * this module does not rescan the overlap to re-prove it: it acquires the
 * suffix, never the prefix. What it does check is the bounded validation contract
 * of `sync.md` §Final replay and validation, evaluated per newly admitted record
 * against the union frontier as that record extends it:
 *
 * - the suffix of each imported writer is contiguous, so no coordinate is skipped
 *   and none is offered twice;
 * - the record's own-writer context coordinate is exactly its predecessor;
 * - every coordinate its context claims is retained by the union, including the
 *   record itself;
 * - every coordinate it references is either covered by its own context or an
 *   earlier coordinate of the same writer's publication;
 * - a `ValidateEvent`'s target and each non-`"unknown"` basis value, and a value-
 *   or proof-scoped `InvalidateEvent`'s scope value, resolve in the admitted change
 *   set to a `ValueEvent` of the expected node; and
 * - an admitted `ValidateEvent`'s basis is the current canonical shape of its
 *   node, with no duplicate semantic input.
 *
 * Transitive closure of a context and authority extension are relations over the
 * complete admitted change set, so they are checked by `validateAdmittedRelations`
 * against a per-writer running maximum of the admitted records, not by reading
 * retained history. A coordinate the change set does not hold is a retained-prefix
 * coordinate whose closure and authority were established when the receiver
 * admitted it, so this module does not rescan it. `incremental-graph-journal-
 * theorems.md` Laws 8 and 8a prove shared-prefix identity — no writer forks — for
 * compatible supported inputs; they do not prove context closure, so closure is
 * checked here rather than assumed. Re-deriving it by reading the claimed prefixes
 * would break the change-bounded read bound that `storage.md`
 * §Synchronization/reset validation requires and that
 * `journal_sync_retained_state.test.js` pins.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/records').SemanticEvent} SemanticEvent */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalFrontier} JournalFrontier */
/** @typedef {import('../journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('../journal/types').JournalSequence} JournalSequence */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('../journal/oracle/record_source').PrefixReader} PrefixReader */
/** @typedef {import('../journal/types').NodeKey} NodeKey */
/** @typedef {import('./admission').AdmittedIndex} AdmittedIndex */

const { makeAdmittedIndex, validateAdmittedRelations, validateImportedRecord } = require("./admission");
const { readRetainedOverlap } = require("./retained_overlap");

const {
    compareJournalSequence,
    isJournalError,
    isSameJournalAuthor,
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceToString,
    makeJournalFrontier,
    makeJournalGapError,
    makeJournalRecordValidationError,
    makeJournalWriterBehindError,
    readerOverIterable,
    requireSuccessorJournalSequence,
    suffixReaderOf,
    ZERO_JOURNAL_SEQUENCE,
} = require("../journal");


/**
 * The properties that this class carries are:
 * - `from` is one past the receiver's retained length for `author`, and `to` is
 *   the source's retained length for `author`, so the imported range is exactly
 *   `A:(FR[A]+1) .. FS[A]`; and
 * - `reader()` returns a fresh reader over exactly that range, in ascending
 *   writer-local sequence order, so the suffix is consumed incrementally and is
 *   never held as one in-RAM collection.
 *
 * The proof of those properties is guaranteed by:
 * - `planForeignSuffixImport(...)`: it admits `author` only when the source's
 *   retained length strictly exceeds the receiver's, names `from` as the
 *   successor of the receiver's length and `to` as the source's length, and
 *   consumes the very range `reader()` reproduces during admission, so the range
 *   is contiguous and starts one past the receiver's retained length.
 * - `reader()`: it asks the source for a positioned suffix reader at `from`,
 *   bounded by the writer's declared retained length, so every call reproduces
 *   the same contiguous range without materialising it.
 *
 * @param {JournalAuthor} author
 * @param {JournalSequence} from - The first imported coordinate.
 * @param {JournalSequence} to - The source's retained length for `author`.
 * @param {JournalSource} source - The held source snapshot the suffix is read from.
 */
class ImportedSuffixClass {
    /**
     * @param {JournalAuthor} author
     * @param {JournalSequence} from
     * @param {JournalSequence} to
     * @param {JournalSource} source
     */
    constructor(author, from, to, source) {
        this.author = author;
        this.from = from;
        this.to = to;
        this.source = source;
    }

    /**
     * A fresh reader over this suffix's records, from `from` through `to`.
     *
     * @returns {import('../journal/oracle/record_source').PrefixReader}
     */
    reader() {
        return suffixReaderOf(this.source, this.author, this.from);
    }
}

/** @typedef {ImportedSuffixClass} ImportedSuffix */

/**
 * The properties that this class carries are:
 * - `suffixes` names exactly the foreign writers whose source length exceeds the
 *   receiver's, in ascending writer order, and nothing else; and
 * - `frontier` covers the union of the receiver's retained journal and every
 *   imported suffix.
 *
 * The proof of those properties is guaranteed by:
 * - `planForeignSuffixImport(...)`: it enumerates the source's writers, skips the
 *   receiver's own writer, and admits a writer exactly when its source retained
 *   length is strictly greater than the receiver's; and it advances `frontier` by
 *   joining each admitted writer's imported `to` as that suffix is read.
 *
 * @param {ReadonlyArray<ImportedSuffix>} suffixes
 * @param {JournalFrontier} frontier
 */
class ImportPlanClass {
    /**
     * @param {ReadonlyArray<ImportedSuffix>} suffixes
     * @param {JournalFrontier} frontier
     */
    constructor(suffixes, frontier) {
        this.suffixes = suffixes;
        this.frontier = frontier;
    }
}

/** @typedef {ImportPlanClass} ImportPlan */

/**
 * @param {unknown} value
 * @returns {value is ImportPlan}
 */
function isImportPlan(value) {
    return value instanceof ImportPlanClass;
}

/**
 * Extend a frontier with one writer's coordinate.
 *
 * @param {JournalFrontier} frontier
 * @param {JournalAuthor} author
 * @param {JournalSequence} sequence
 * @returns {JournalFrontier | JournalError}
 */
function advanceFrontier(frontier, author, sequence) {
    /** @type {Array<[JournalAuthor, JournalSequence]>} */
    const entries = [];
    let advanced = false;
    for (const coordinate of frontier) {
        if (isSameJournalAuthor(coordinate[0], author)) {
            entries.push([
                coordinate[0],
                compareJournalSequence(coordinate[1], sequence) < 0 ? sequence : coordinate[1],
            ]);
            advanced = true;
            continue;
        }
        entries.push([coordinate[0], coordinate[1]]);
    }
    if (!advanced) {
        entries.push([author, sequence]);
    }
    return makeJournalFrontier(entries);
}

/**
 * Validate the same-ID evidence at one writer's retained seam.
 *
 * A coordinate the source offers at or below `afterSequence` is evidence about a
 * coordinate the receiver already retains, so it is compared against the
 * receiver's own record rather than admitted, and two records which claim that
 * identity with different canonical meaning are refused as a writer fork. A
 * source which opens above `afterSequence` reaches none of this. The first
 * missing record the seam reports is discarded: the acquisition re-reads the
 * suffix from its first coordinate through `ImportedSuffix.reader()`, so the
 * suffix is not carried out of the seam check.
 *
 * A source which offers positioned reads is opened at the first missing
 * coordinate `afterSequence + 1` and therefore presents no retained coordinate at
 * all: `readRetainedOverlap` sees the opening record above the receiver's
 * retained length immediately and the receiver's stream is never opened. That is
 * what makes `incremental-graph-journal-sync.md` §Immutable overlap law's
 * "ordinary synchronization does not rescan or compare the complete retained
 * overlap" hold for every source the product constructs, all of which implement
 * `suffixReaderOf` (`makeReplicaSource`, `makeUnionSource`, `makeSyncJournalSource`
 * and the durable sublevel source). A source which offers only a whole-prefix
 * reader cannot be positioned, so the seam reads through its prefix and compares
 * the retained coordinates it necessarily passes, which is the same-ID evidence
 * such a source actually offers; that path is exercised only by hand-built
 * `JournalSource`s and costs no production read.
 *
 * @param {JournalSource} source
 * @param {JournalSource} receiver
 * @param {JournalAuthor} author
 * @param {JournalSequence} afterSequence - The receiver's retained length.
 * @returns {Promise<JournalError | undefined>}
 */
async function validateSuffixSeam(source, receiver, author, afterSequence) {
    const firstMissing = requireSuccessorJournalSequence(afterSequence);
    if (isJournalError(firstMissing)) {
        return firstMissing;
    }
    const sourceReader = source.suffixReaderOf === undefined
        ? source.prefixReaderOf(author)
        : source.suffixReaderOf(author, firstMissing);
    const overlap = await readRetainedOverlap(
        sourceReader,
        receiver.prefixReaderOf(author),
        journalAuthorToString(author),
        afterSequence
    );
    return "error" in overlap ? overlap.error : undefined;
}

/**
 * Admit one writer's missing suffix into the running admitted-relations index,
 * validating each record as it is read.
 *
 * The suffix is consumed one record at a time through `suffix.reader()` and is
 * never held as a collection. Each admitted record is validated against the union
 * frontier as that record extends it, and folded into the index the relation
 * checks later re-read the change set against.
 *
 * @param {ImportedSuffix} suffix
 * @param {JournalFrontier} frontier - The complete union frontier.
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} currentInputKeysOfNode
 * @param {AdmittedIndex} index
 * @returns {Promise<{frontier: JournalFrontier} | {error: JournalError}>}
 */
async function admitSuffix(suffix, frontier, currentInputKeysOfNode, index) {
    const authorName = journalAuthorToString(suffix.author);
    const reader = suffix.reader();
    /** @type {JournalFrontier} */
    let current = frontier;
    /** @type {JournalSequence} */
    let expected = suffix.from;
    for (;;) {
        const record = await reader.nextRecord();
        if (record === undefined) {
            const failure = reader.failure();
            if (failure !== undefined) {
                return { error: failure };
            }
            break;
        }
        if (journalAuthorToString(record.id.author) !== authorName) {
            return {
                error: makeJournalRecordValidationError(
                    "the imported suffix of " + authorName + " offers a record filed under " +
                        journalAuthorToString(record.id.author),
                    journalRecordIdToString(record.id)
                ),
            };
        }
        if (compareJournalSequence(record.id.sequence, expected) !== 0) {
            return {
                error: makeJournalGapError(
                    authorName,
                    journalSequenceToString(expected),
                    journalSequenceToString(record.id.sequence)
                ),
            };
        }
        const advanced = advanceFrontier(current, suffix.author, expected);
        if (advanced instanceof Error) {
            return { error: advanced };
        }
        current = advanced;
        const invalid = validateImportedRecord(record, current, currentInputKeysOfNode);
        if (invalid !== undefined) {
            return { error: invalid };
        }
        index.add(record);
        const following = requireSuccessorJournalSequence(expected);
        if (isJournalError(following)) {
            return { error: following };
        }
        expected = following;
    }
    return { frontier: current };
}

/**
 * Re-read one writer's missing suffix and check each admitted record's transitive
 * closure, authority extension and self-described references against the complete
 * index.
 *
 * The suffix is re-read from its first coordinate rather than retained, so the
 * relation-shaped half of the validation contract costs one more streaming pass
 * and no in-RAM copy of the change set. The index is complete because every
 * suffix was admitted before any relation was checked.
 *
 * @param {ImportedSuffix} suffix
 * @param {AdmittedIndex} index
 * @param {JournalFrontier} frontier - The complete union frontier.
 * @returns {Promise<JournalError | undefined>}
 */
async function checkSuffixRelations(suffix, index, frontier) {
    const reader = suffix.reader();
    for (;;) {
        const record = await reader.nextRecord();
        if (record === undefined) {
            return reader.failure();
        }
        const relations = validateAdmittedRelations(record, index, frontier);
        if (relations !== undefined) {
            return relations;
        }
    }
}

/**
 * Plan the acquisition of every missing foreign-writer suffix.
 *
 * The receiver's own writer is not a foreign writer, so it is never imported. A
 * source which retains more of the receiver's own writer stream than the receiver
 * does is unsupported state rather than a longer peer prefix, and the plan reports
 * it before any record is admitted.
 *
 * @param {object} plan
 * @param {JournalSource} plan.receiver - The receiver's retained journal.
 * @param {JournalSource} plan.source - The one held compatible source snapshot.
 * @param {JournalAuthor} plan.localWriter - The receiver's own writer.
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} plan.currentInputKeysOfNode
 * @returns {Promise<ImportPlan | {error: JournalError}>}
 */
async function planForeignSuffixImport(plan) {
    const { receiver, source, localWriter, currentInputKeysOfNode } = plan;
    const localName = journalAuthorToString(localWriter);

    const sourceLocalLength = source.retainedLengthOf(localWriter);
    if (sourceLocalLength !== undefined) {
        // A receiver with no record for its own writer retains length zero, not
        // "unknown": `retainedLengthOf` reports `undefined` for a writer with no
        // records, so the comparison must treat that as zero or a source ahead of
        // an empty own writer would be silently accepted.
        const receiverLocalLength = receiver.retainedLengthOf(localWriter);
        const receiverAfter = receiverLocalLength === undefined
            ? ZERO_JOURNAL_SEQUENCE
            : receiverLocalLength;
        if (compareJournalSequence(sourceLocalLength, receiverAfter) > 0) {
            return {
                error: makeJournalWriterBehindError(
                    journalAuthorToString(localWriter),
                    journalSequenceToString(receiverAfter),
                    journalSequenceToString(sourceLocalLength)
                ),
            };
        }
    }

    /** @type {ImportedSuffix[]} */
    const suffixes = [];
    const empty = makeJournalFrontier([]);
    if (empty instanceof Error) {
        return { error: empty };
    }
    // The union frontier is the receiver's retained lengths joined with every
    // imported suffix's final length, and it is completed before a single record
    // is validated. Bounded range coverage compares a record's context against
    // the union, so a record from one imported writer may legitimately name a
    // coordinate of another imported writer whose suffix has not been read yet;
    // validating against the acquisition-order prefix would reject a well-formed,
    // causally closed source merely because of writer-name order.
    /** @type {JournalFrontier} */
    let frontier = empty;
    for (const author of receiver.writers()) {
        const length = receiver.retainedLengthOf(author);
        if (length === undefined) {
            continue;
        }
        const advanced = advanceFrontier(frontier, author, length);
        if (advanced instanceof Error) {
            return { error: advanced };
        }
        frontier = advanced;
    }
    for (const author of source.writers()) {
        if (journalAuthorToString(author) === localName) {
            continue;
        }
        const sourceLength = source.retainedLengthOf(author);
        if (sourceLength === undefined) {
            continue;
        }
        const receiverLength = receiver.retainedLengthOf(author);
        const after = receiverLength === undefined ? ZERO_JOURNAL_SEQUENCE : receiverLength;
        if (compareJournalSequence(sourceLength, after) <= 0) {
            continue;
        }
        const advanced = advanceFrontier(frontier, author, sourceLength);
        if (advanced instanceof Error) {
            return { error: advanced };
        }
        frontier = advanced;
    }

    // Transitive closure and authority extension are relations between a record and
    // every event it claims to have observed, so they are checked over the complete
    // admitted change set rather than as each suffix is read. Every suffix is
    // therefore admitted first into one running index, and then re-read to check
    // each record against that complete index. The index is the only derived state
    // which spans the change set; the records themselves are streamed twice and
    // never held as one collection.
    const index = makeAdmittedIndex();

    for (const author of source.writers()) {
        if (journalAuthorToString(author) === localName) {
            continue;
        }
        const sourceLength = source.retainedLengthOf(author);
        if (sourceLength === undefined) {
            continue;
        }
        const receiverLength = receiver.retainedLengthOf(author);
        const after = receiverLength === undefined ? ZERO_JOURNAL_SEQUENCE : receiverLength;
        if (compareJournalSequence(sourceLength, after) <= 0) {
            continue;
        }
        const seam = await validateSuffixSeam(source, receiver, author, after);
        if (seam !== undefined) {
            return { error: seam };
        }
        const firstExpected = requireSuccessorJournalSequence(after);
        if (isJournalError(firstExpected)) {
            return { error: firstExpected };
        }
        const suffix = new ImportedSuffixClass(author, firstExpected, sourceLength, source);
        const admitted = await admitSuffix(suffix, frontier, currentInputKeysOfNode, index);
        if ("error" in admitted) {
            return { error: admitted.error };
        }
        suffixes.push(suffix);
    }

    for (const suffix of suffixes) {
        const relations = await checkSuffixRelations(suffix, index, frontier);
        if (relations !== undefined) {
            return { error: relations };
        }
    }

    return new ImportPlanClass(suffixes, frontier);
}

/**
 * The retained-journal read surface of the imported suffixes alone.
 *
 * Each imported writer's reader starts at the first imported coordinate rather
 * than at the canonical first one, so unioning this source with the receiver's
 * own retained journal yields one contiguous stream per writer without the union
 * having to re-read the overlap it already holds.
 *
 * @param {ImportPlan} plan
 * @returns {JournalSource}
 */
function importedSourceOf(plan) {
    /** @type {Map<string, ImportedSuffix>} */
    const byName = new Map();
    for (const suffix of plan.suffixes) {
        byName.set(journalAuthorToString(suffix.author), suffix);
    }
    return {
        writers: () => plan.suffixes.map((suffix) => suffix.author),
        retainedLengthOf: (author) => {
            const suffix = byName.get(journalAuthorToString(author));
            return suffix === undefined ? undefined : suffix.to;
        },
        prefixReaderOf: (author) => {
            const suffix = byName.get(journalAuthorToString(author));
            if (suffix === undefined) {
                return readerOverIterable(
                    journalAuthorToString(author),
                    [],
                    ZERO_JOURNAL_SEQUENCE
                );
            }
            return suffix.reader();
        },
        suffixReaderOf: (author, fromSequence) => {
            const suffix = byName.get(journalAuthorToString(author));
            if (suffix === undefined) {
                return readerOverIterable(
                    journalAuthorToString(author),
                    [],
                    ZERO_JOURNAL_SEQUENCE,
                    fromSequence
                );
            }
            const start = compareJournalSequence(fromSequence, suffix.from) < 0
                ? suffix.from
                : fromSequence;
            return suffixReaderOf(suffix.source, suffix.author, start);
        },
    };
}

module.exports = {
    ImportedSuffixClass,
    ImportPlanClass,
    advanceFrontier,
    importedSourceOf,
    isImportPlan,
    planForeignSuffixImport,
};