/**
 * The cuts one reset reads its derived state from.
 *
 * Every pass of `incremental-graph-journal-reset.md` is evaluated at a named cut:
 * the raw union `J0` has no projection at all, `P1` follows Pass 1, the barrier set
 * is read at the fixed `P1` cut before any barrier is authored, and the validity
 * and freshness decisions follow the barriers and the certificates. This module
 * holds the operations which produce those cuts, so the pass module reads as the
 * specification's sequence of decisions rather than as plumbing.
 *
 * A cut is a retained-journal union plus, where the specification needs one, its
 * projection and the identity views the certificate and invalidation passes read.
 * Building them here keeps the "which records does this cut hold" question in one
 * place: the receiver's retained journal, the imported suffix, and the receiver's
 * own contiguous authored ranges.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('../journal/types').NodeKey} NodeKey */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('../journal/oracle/projection').ProjectedOccurrence} ProjectedOccurrence */
/** @typedef {import('../journal/oracle/projection').Projection} Projection */
/** @typedef {import('../journal_sync').ImportPlan} ImportPlan */

const {
    isJournalError,
    isProjection,
    journalAuthorToString,
    makeJournalFrontier,
    makeJournalProjectionError,
    makeJournalPublicationError,
    makeUnionSource,
    projectRetainedJournal,
} = require("../journal");
const { importedSourceOf, ImportedSuffixClass, ImportPlanClass } = require("../journal_sync");

/**
 * The raw union `J0 = union(JR, S)`: the receiver's retained journal plus every
 * missing source record, unchanged.
 *
 * @param {object} step
 * @param {JournalSource} step.receiver
 * @param {ImportPlan} step.plan
 * @returns {JournalSource}
 */
function observedUnion(step) {
    const { receiver, plan } = step;
    let imported = 0;
    for (const suffix of plan.suffixes) {
        imported += suffix.records.length;
    }
    if (imported === 0) {
        return receiver;
    }
    return makeUnionSource([receiver, importedSourceOf(plan)]);
}

/**
 * The records one allocation authored, as the import plan's read surface.
 *
 * The reader is offered from the first authored coordinate rather than from the
 * canonical first one, so unioning it with the union it extends yields one
 * contiguous stream per writer without the union re-reading its overlap.
 *
 * @param {JournalAuthor} localWriter
 * @param {ReadonlyArray<JournalRecord>} records
 * @returns {JournalSource | JournalError}
 */
function sourceOfAuthoredRange(localWriter, records) {
    const name = journalAuthorToString(localWriter);
    for (const record of records) {
        if (journalAuthorToString(record.id.author) !== name) {
            return makeJournalPublicationError(
                "a reset publication allocated a record under another writer"
            );
        }
    }
    const first = records[0];
    if (first === undefined) {
        return makeJournalPublicationError("a reset publication allocated no record");
    }
    const seed = makeJournalFrontier([[localWriter, first.id.sequence]]);
    if (isJournalError(seed)) {
        return seed;
    }
    return importedSourceOf(
        new ImportPlanClass([new ImportedSuffixClass(localWriter, first.id.sequence, records)], seed)
    );
}

/**
 * Extend a cut by one contiguous own-writer range the receiver authored.
 *
 * @param {JournalSource} base
 * @param {JournalAuthor} localWriter
 * @param {ReadonlyArray<JournalRecord>} records - The records this allocation
 *   authored, in ascending own-writer order and starting at the committed head
 *   successor.
 * @returns {JournalSource | JournalError}
 */
function extendWithOwnRange(base, localWriter, records) {
    if (records.length === 0) {
        return base;
    }
    const range = sourceOfAuthoredRange(localWriter, records);
    if (isJournalError(range)) {
        return range;
    }
    return makeUnionSource([base, range]);
}

/**
 * Project one cut.
 *
 * @param {JournalSource} source
 * @param {JournalAuthor} localWriter
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} currentInputKeysOfNode
 * @returns {Projection | {error: JournalError}}
 */
function projectCut(source, localWriter, currentInputKeysOfNode) {
    const projection = projectRetainedJournal({ source, localWriter, currentInputKeysOfNode });
    if (isJournalError(projection)) {
        return { error: projection };
    }
    if (!isProjection(projection)) {
        return {
            error: makeJournalProjectionError("replay did not produce a projection", "reset"),
        };
    }
    return projection;
}

/**
 * The writer identity index the invalidation-coverage comparison reads.
 *
 * @param {JournalSource} source
 * @returns {(name: string) => JournalAuthor | undefined}
 */
function authorLookupOf(source) {
    /** @type {Map<string, JournalAuthor>} */
    const index = new Map();
    for (const author of source.writers()) {
        index.set(journalAuthorToString(author), author);
    }
    return (name) => index.get(name);
}

/**
 * @param {Projection} projection
 * @returns {Map<string, ProjectedOccurrence>}
 */
function occurrencesByKey(projection) {
    return new Map(projection.occurrences.map((occurrence) => [occurrence.nodeKeyString, occurrence]));
}

/**
 * The occurrence identities the invalidation and certificate passes compare
 * against at this cut.
 *
 * @param {Projection} projection
 * @returns {Map<string, {node: NodeKey, valueId: JournalRecordId}>}
 */
function selectedOccurrencesOf(projection) {
    /** @type {Map<string, {node: NodeKey, valueId: JournalRecordId}>} */
    const selected = new Map();
    for (const [nodeKeyString, occurrence] of occurrencesByKey(projection)) {
        selected.set(nodeKeyString, { node: occurrence.nodeKey, valueId: occurrence.valueId });
    }
    return selected;
}

module.exports = {
    authorLookupOf,
    extendWithOwnRange,
    observedUnion,
    occurrencesByKey,
    projectCut,
    selectedOccurrencesOf,
    sourceOfAuthoredRange,
};