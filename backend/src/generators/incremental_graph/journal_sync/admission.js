/**
 * The bounded validation contract for one newly admitted record.
 *
 * `incremental-graph-journal-sync.md` §Final replay and validation requires each
 * record an acquisition admits to be validated as it is admitted, against the
 * union frontier as that record extends it. Every rule here is evaluated from the
 * record's own fields and the frontier, so the validation is change-bounded: it
 * reads no retained history beyond the coordinates the record itself claims or
 * names.
 *
 * Transitive context closure and authority extension are not re-derived here,
 * because `incremental-graph-journal-theorems.md` Law 8a supplies them for the
 * causally closed frontier the importing writer observed.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/records').SemanticEvent} SemanticEvent */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalFrontier} JournalFrontier */
/** @typedef {import('../journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('../journal/types').NodeKey} NodeKey */

const {
    compareJournalSequence,
    isSameJournalAuthor,
    isSemanticEvent,
    isValidateEvent,
    journalRecordIdToString,
    journalSequenceAtFrontier,
    makeJournalRecordValidationError,
    makeJournalReferenceCausalityError,
    nodeKeyToCanonicalString,
    predecessorJournalSequence,
    validateCompleteLocalPrefix,
    validateCurrentShapeBasis,
    validateNoForwardOwnWriterReference,
    validateOrdinaryBasisReasons,
    validateRetainedRangeCoverage,
} = require("../journal");

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

module.exports = {
    validateImportedRecord,
};
