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
 * `JournalSource`s and returns the retained suffix to admit together with the
 * union frontier those records extend, so it performs no I/O, holds no locks and
 * owns no lifecycle.
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
 *   earlier coordinate of the same writer's publication; and
 * - an admitted `ValidateEvent`'s basis is the current canonical shape of its
 *   node, with no duplicate semantic input.
 *
 * Transitive closure of a context and authority extension follow from the
 * causally closed retained frontier the imported writer observed, which the
 * prefix identity theorem supplies. Re-deriving them here would be the
 * whole-history rescan that `sync.md` §Immutable overlap law forbids.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/records').SemanticEvent} SemanticEvent */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalFrontier} JournalFrontier */
/** @typedef {import('../journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('../journal/types').JournalSequence} JournalSequence */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('../journal/types').NodeKey} NodeKey */

const {
    compareJournalSequence,
    isJournalError,
    isSameJournalAuthor,
    isSemanticEvent,
    isValidateEvent,
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceAtFrontier,
    journalSequenceToString,
    makeJournalFrontier,
    makeJournalGapError,
    makeJournalRecordValidationError,
    makeJournalReferenceCausalityError,
    makeJournalWriterBehindError,
    nodeKeyToCanonicalString,
    predecessorJournalSequence,
    readerOverIterable,
    requireSuccessorJournalSequence,
    validateCompleteLocalPrefix,
    validateCurrentShapeBasis,
    validateNoForwardOwnWriterReference,
    validateOrdinaryBasisReasons,
    validateRetainedRangeCoverage,
    ZERO_JOURNAL_SEQUENCE,
} = require("../journal");


/**
 * The properties that this class carries are:
 * - `records` is exactly `A:(FR[A]+1) .. FS[A]` for one imported writer `A`, in
 *   ascending writer-local sequence order, with every record's own `id` the
 *   coordinate it occupies; and
 * - `to` is the greatest imported coordinate, which is the length that writer's
 *   retained prefix has after the import.
 *
 * The proof of those properties is guaranteed by:
 * - `planForeignSuffixImport(...)`: it names the range from the two frontiers and
 *   admits only a record whose own coordinate is exactly the next one expected,
 *   so the admitted range is contiguous and starts one past the receiver's
 *   retained length.
 *
 * @param {JournalAuthor} author
 * @param {JournalSequence} from - The first imported coordinate.
 * @param {ReadonlyArray<JournalRecord>} records
 */
class ImportedSuffixClass {
    /**
     * @param {JournalAuthor} author
     * @param {JournalSequence} from
     * @param {ReadonlyArray<JournalRecord>} records
     */
    constructor(author, from, records) {
        this.author = author;
        this.from = from;
        this.records = records;
        const last = records[records.length - 1];
        /** @type {JournalSequence} */
        this.to = last === undefined ? ZERO_JOURNAL_SEQUENCE : last.id.sequence;
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
 * Is the coordinate a record references covered by what that record observed?
 *
 * A reference is causal exactly when the referencing event's context already
 * covers the referenced coordinate. Within one writer publication the context's
 * own coordinate is the record's predecessor, so an earlier same-writer
 * coordinate is covered by that same rule.
 *
 * @param {SemanticEvent} event
 * @param {JournalRecordId} referenced
 * @returns {boolean}
 */
function referenceIsObserved(event, referenced) {
    const record = event;
    if (
        compareJournalSequence(
            referenced.sequence,
            journalSequenceAtFrontier(record.context, referenced.author)
        ) <= 0
    ) {
        return true;
    }
    if (!isSameJournalAuthor(referenced.author, record.id.author)) {
        return false;
    }
    const predecessor = predecessorJournalSequence(record.id.sequence);
    return !(predecessor instanceof Error) &&
        compareJournalSequence(referenced.sequence, predecessor) <= 0;
}

/**
 * The ValueId coordinates one record names, or an empty array when it names none.
 *
 * @param {JournalRecord} record
 * @returns {ReadonlyArray<JournalRecordId>}
 */
function referencedIdsOf(record) {
    if (isValidateEvent(record)) {
        return [record.value];
    }
    if (record.kind === "invalidate" && record.scope.kind === "value") {
        return [record.scope.value];
    }
    return [];
}

/**
 * The canonical NodeKey identities a record's validation basis names.
 * @param {JournalRecord} record
 * @returns {ReadonlyArray<string>}
 */
function basisInputsOf(record) {
    if (!isValidateEvent(record)) {
        return [];
    }
    return record.basis.map((entry) => nodeKeyToCanonicalString(entry.input));
}

/**
 * Check one newly admitted record against the bounded validation contract.
 *
 * @param {JournalRecord} record
 * @param {JournalFrontier} frontier - The union frontier including `record`.
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} currentInputKeysOfNode
 * @returns {JournalError | undefined}
 */
function validateImportedRecord(record, frontier, currentInputKeysOfNode) {
    if (!isSemanticEvent(record)) {
        return validateNoForwardOwnWriterReference(record);
    }
    const ownPrefix = validateCompleteLocalPrefix(record);
    if (ownPrefix !== undefined) {
        return ownPrefix;
    }
    const retained = validateRetainedRangeCoverage(record, frontier);
    if (retained !== undefined) {
        return retained;
    }
    const forward = validateNoForwardOwnWriterReference(record);
    if (forward !== undefined) {
        return forward;
    }
    for (const referenced of referencedIdsOf(record)) {
        if (referenceIsObserved(record, referenced)) {
            continue;
        }
        return makeJournalReferenceCausalityError(
            journalRecordIdToString(record.id),
            journalRecordIdToString(referenced),
            "the referencing record's context does not cover the coordinate it names"
        );
    }
    if (!isValidateEvent(record)) {
        return undefined;
    }
    const reasons = validateOrdinaryBasisReasons(record);
    if (reasons !== undefined) {
        return reasons;
    }
    const basisInputs = basisInputsOf(record);
    const unique = new Set(basisInputs);
    if (unique.size !== basisInputs.length) {
        return makeJournalRecordValidationError(
            "the admitted validation basis names a semantic input twice",
            journalRecordIdToString(record.id)
        );
    }
    return validateCurrentShapeBasis(record, currentInputKeysOfNode);
}

/**
 * Read one writer's missing suffix out of the source, admitting only a record at
 * exactly the next expected coordinate, and validate it as it is admitted.
 *
 * @param {JournalSource} source
 * @param {JournalAuthor} author
 * @param {JournalSequence} afterSequence - The receiver's retained length.
 * @param {JournalFrontier} frontier - The union frontier before this writer.
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} currentInputKeysOfNode
 * @returns {{suffix: ImportedSuffix, frontier: JournalFrontier} | {error: JournalError}}
 */
function acquireSuffix(source, author, afterSequence, frontier, currentInputKeysOfNode) {
    const reader = source.prefixReaderOf(author);
    const authorName = journalAuthorToString(author);
    /** @type {JournalRecord[]} */
    const records = [];
    /** @type {JournalFrontier} */
    let current = frontier;
    const firstExpected = requireSuccessorJournalSequence(afterSequence);
    if (isJournalError(firstExpected)) {
        return { error: firstExpected };
    }
    /** @type {import('../journal/types').JournalSequence} */
    let expected = firstExpected;

    for (;;) {
        const record = reader.nextRecord();
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
        const advanced = advanceFrontier(current, author, expected);
        if (advanced instanceof Error) {
            return { error: advanced };
        }
        current = advanced;
        const invalid = validateImportedRecord(record, current, currentInputKeysOfNode);
        if (invalid !== undefined) {
            return { error: invalid };
        }
        records.push(record);
        const following = requireSuccessorJournalSequence(expected);
        if (isJournalError(following)) {
            return { error: following };
        }
        expected = following;
    }
    return {
        suffix: new ImportedSuffixClass(author, firstExpected, records),
        frontier: current,
    };
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
 * @returns {ImportPlan | {error: JournalError}}
 */
function planForeignSuffixImport(plan) {
    const { receiver, source, localWriter, currentInputKeysOfNode } = plan;
    const localName = journalAuthorToString(localWriter);

    const sourceLocalLength = source.retainedLengthOf(localWriter);
    if (sourceLocalLength !== undefined) {
        const receiverLocalLength = receiver.retainedLengthOf(localWriter);
        if (
            receiverLocalLength !== undefined &&
            compareJournalSequence(sourceLocalLength, receiverLocalLength) > 0
        ) {
            return {
                error: makeJournalWriterBehindError(
                    journalAuthorToString(localWriter),
                    journalSequenceToString(receiverLocalLength),
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
    // The union frontier starts at what the receiver already retains, because a
    // newly admitted record may claim any coordinate the receiver holds. Only the
    // imported suffixes advance it.
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
        const acquired = acquireSuffix(source, author, after, frontier, currentInputKeysOfNode);
        if ("error" in acquired) {
            return { error: acquired.error };
        }
        frontier = acquired.frontier;
        suffixes.push(acquired.suffix);
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
            return readerOverIterable(
                journalAuthorToString(author),
                suffix.records,
                suffix.to,
                suffix.from
            );
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
    validateImportedRecord,
};