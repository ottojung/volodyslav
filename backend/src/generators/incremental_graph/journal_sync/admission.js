/**
 * The bounded validation contract for newly admitted records.
 *
 * `incremental-graph-journal-sync.md` §Final replay and validation requires each
 * record an acquisition admits to be validated as it is admitted, against the
 * union frontier as that record extends it, and requires the contexts of newly
 * admitted records to have exact own prefix and transitive closure and their
 * authority to extend happened-before. Every rule here is evaluated from the
 * records admitted by the current operation and the coordinates they claim, so
 * the validation is change-bounded: it reads no retained history beyond the
 * coordinates the records themselves name.
 *
 * ## Two checks, two shapes
 *
 * `validateImportedRecord` is the per-record check: a record is validated as its
 * own suffix reader produces it, from its own fields and the union frontier. It
 * establishes own-prefix exactness, retained-range coverage, reference causality,
 * basis canonicality and current shape.
 *
 * Transitive closure and authority extension are relations between a record and
 * every event it claims to have observed, so they are checked by
 * `validateAdmittedRecords` over the complete set of records one operation
 * admits. The set is the change set `C`, not the retained history: the check
 * builds a per-writer running maximum of the admitted records' contexts and
 * authority, and each record is compared against the maximum of the writers it
 * claims. A claimed coordinate whose writer retains nothing in this operation's
 * change set is a retained-prefix coordinate; its context and authority belong to
 * the receiver's already validated history and are not rescanned here. This is
 * the bounded form `incremental-graph-journal-storage.md` §Synchronization/reset
 * validation permits, and it rejects the `incremental-graph-journal-well-
 * formedness.md` §Transitive closure malformed history as soon as the offending
 * records are part of the admitted suffix.
 *
 * `incremental-graph-journal-theorems.md` Law 8a proves shared-prefix identity —
 * no writer forks — for compatible supported inputs; it does not prove context
 * closure, so closure is checked here rather than assumed.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/records').SemanticEvent} SemanticEvent */
/** @typedef {import('../journal/types').AuthorityTime} AuthorityTime */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalFrontier} JournalFrontier */
/** @typedef {import('../journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('../journal/types').JournalSequence} JournalSequence */
/** @typedef {import('../journal/types').NodeKey} NodeKey */

const {
    authorityCompare,
    compareJournalSequence,
    isInvalidateEvent,
    isSameJournalAuthor,
    isSemanticEvent,
    isValidateEvent,
    isValueEvent,
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceAtFrontier,
    journalSequenceToString,
    makeJournalCausalClosureError,
    makeJournalRecordValidationError,
    makeJournalReferenceCausalityError,
    nodeKeyToCanonicalString,
    predecessorJournalSequence,
    validateCompleteLocalPrefix,
    validateCurrentShapeBasis,
    validateNoForwardOwnWriterReference,
    validateOrdinaryBasisReasons,
    validateRetainedRangeCoverage,
    ZERO_JOURNAL_SEQUENCE,
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
 * A validation names its target occurrence and, for every explicit input, the
 * occurrence it used as that input; `incremental-graph-journal-well-formedness.md`
 * section Validation basis rules items 4 and 5 require each non-`"unknown"` basis
 * value to be a retained ValueEvent of the declared input node that happened-before
 * the validation, so every basis occurrence is a coordinate the record names. A
 * value scope and a proof scope both name a ValueId: they retire something about
 * the named occurrence. Only the node scope names no coordinate.
 *
 * @param {JournalRecord} record
 * @returns {ReadonlyArray<JournalRecordId>}
 */
function referencedIdsOf(record) {
    if (isValidateEvent(record)) {
        const references = [record.value];
        for (const entry of record.basis) {
            if (entry.value !== "unknown") {
                references.push(entry.value);
            }
        }
        return references;
    }
    if (record.kind === "invalidate" && record.scope.kind !== "node") {
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
 * The part of a semantic event the authority relation reads.
 * @typedef {object} AdmittedAuthorityRef
 * @property {JournalRecordId} id
 * @property {JournalFrontier} context
 * @property {AuthorityTime} authorityTime
 */

/**
 * One admitted writer's running maximum, indexed by coordinate.
 *
 * @typedef {object} AdmittedWriterMaximum
 * @property {JournalSequence} sequence - The coordinate this entry's maxima are
 *   computed through.
 * @property {Array<[JournalAuthor, JournalSequence]>} context - The componentwise
 *   maximum of every admitted context of this writer at or below `sequence`.
 * @property {AdmittedAuthorityRef} authority - The greatest admitted authority of
 *   this writer at or below `sequence`, under `authorityCompare`.
 */

/**
 * The componentwise maximum of two context frontiers.
 *
 * @param {Array<[JournalAuthor, JournalSequence]>} left
 * @param {JournalFrontier} right
 * @returns {Array<[JournalAuthor, JournalSequence]>}
 */
function mergeContextMaximum(left, right) {
    /** @type {Map<string, [JournalAuthor, JournalSequence]>} */
    const merged = new Map();
    for (const [author, sequence] of left) {
        merged.set(journalAuthorToString(author), [author, sequence]);
    }
    for (const [author, sequence] of right) {
        const name = journalAuthorToString(author);
        const existing = merged.get(name);
        if (existing === undefined || compareJournalSequence(sequence, existing[1]) > 0) {
            merged.set(name, [author, sequence]);
        }
    }
    return [...merged.values()];
}

/**
 * The per-writer running maximum of the records one operation admits.
 *
 * The index holds only the records of the current change set, so its size is the
 * admitted suffix rather than the retained history. `maximumUpTo` answers the
 * greatest admitted coordinate at or below a claimed one, with the cumulative
 * context and authority maximum through it, or `undefined` when the claimed
 * coordinate is below the writer's admitted suffix and is therefore a
 * retained-prefix coordinate this operation does not rescan.
 */
class AdmittedIndexClass {
    constructor() {
        /** @type {Map<string, Array<AdmittedWriterMaximum>>} */
        this.byWriter = new Map();
        /** @type {Map<string, JournalRecord>} */
        this.byId = new Map();
    }

    /**
     * The admitted record at one coordinate, or `undefined` when the change set
     * does not hold it.
     *
     * @param {JournalRecordId} id
     * @returns {JournalRecord | undefined}
     */
    recordOf(id) {
        return this.byId.get(journalRecordIdToString(id));
    }

    /**
     * @param {JournalRecord} record
     * @returns {void}
     */
    add(record) {
        this.byId.set(journalRecordIdToString(record.id), record);
        if (!isSemanticEvent(record)) {
            return;
        }
        const name = journalAuthorToString(record.id.author);
        const entries = this.byWriter.get(name) ?? [];
        const previous = entries[entries.length - 1];
        const context = previous === undefined
            ? mergeContextMaximum([], record.context)
            : mergeContextMaximum(previous.context, record.context);
        const authority = previous === undefined ||
            authorityCompare(record, previous.authority) > 0
            ? { id: record.id, context: record.context, authorityTime: record.authorityTime }
            : previous.authority;
        entries.push({ sequence: record.id.sequence, context, authority });
        this.byWriter.set(name, entries);
    }

    /**
     * @param {string} name
     * @param {JournalSequence} sequence
     * @returns {AdmittedWriterMaximum | undefined}
     */
    maximumUpTo(name, sequence) {
        const entries = this.byWriter.get(name);
        const first = entries === undefined ? undefined : entries[0];
        if (entries === undefined || first === undefined) {
            return undefined;
        }
        if (compareJournalSequence(sequence, first.sequence) < 0) {
            return undefined;
        }
        let low = 0;
        let high = entries.length - 1;
        let found = 0;
        while (low <= high) {
            const middle = (low + high) >> 1;
            const entry = entries[middle];
            if (entry !== undefined && compareJournalSequence(entry.sequence, sequence) <= 0) {
                found = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        return entries[found];
    }
}

/**
 * Check the transitive closure of one admitted record's context against the
 * admitted change set.
 *
 * For every writer the record claims at coordinate `q`, the maximum of the
 * contexts of that writer's admitted records at or below `q` must be included by
 * the record's own context. A writer with no admitted record at or below `q` is a
 * retained-prefix claim, which this operation does not rescan.
 *
 * @param {SemanticEvent} event
 * @param {AdmittedIndexClass} index
 * @returns {JournalError | undefined}
 */
function validateAdmittedClosure(event, index) {
    const label = journalRecordIdToString(event.id);
    for (const [author, sequence] of event.context) {
        if (compareJournalSequence(sequence, ZERO_JOURNAL_SEQUENCE) === 0) {
            continue;
        }
        const maximum = index.maximumUpTo(journalAuthorToString(author), sequence);
        if (maximum === undefined) {
            continue;
        }
        for (const [observedAuthor, observedSequence] of maximum.context) {
            if (compareJournalSequence(
                observedSequence,
                journalSequenceAtFrontier(event.context, observedAuthor)
            ) > 0) {
                return makeJournalCausalClosureError(
                    label,
                    "transitive closure",
                    "context omits " +
                        journalAuthorToString(observedAuthor) +
                        ":" +
                        journalSequenceToString(observedSequence) +
                        " observed by an event it includes"
                );
            }
        }
    }
    return undefined;
}

/**
 * Check that one admitted record's authority extends every admitted event it
 * causally observes.
 *
 * @param {SemanticEvent} event
 * @param {AdmittedIndexClass} index
 * @returns {JournalError | undefined}
 */
function validateAdmittedAuthority(event, index) {
    const label = journalRecordIdToString(event.id);
    for (const [author, sequence] of event.context) {
        if (compareJournalSequence(sequence, ZERO_JOURNAL_SEQUENCE) === 0) {
            continue;
        }
        const maximum = index.maximumUpTo(journalAuthorToString(author), sequence);
        if (maximum === undefined) {
            continue;
        }
        if (authorityCompare(maximum.authority, event) >= 0) {
            return makeJournalCausalClosureError(
                label,
                "authority consistency",
                "authority does not extend the observed predecessor " +
                    journalRecordIdToString(maximum.authority.id)
            );
        }
    }
    return undefined;
}

/**
 * Check that a ValueId one admitted record names resolves to a `ValueEvent` of
 * the expected node.
 *
 * A coordinate beyond the union frontier is not retained at all, so the
 * reference is impossible and is rejected. A coordinate at or below the frontier
 * which the change set does not hold is a retained-prefix coordinate whose
 * record was validated when the receiver admitted it, so this operation does not
 * rescan it. A coordinate the change set does hold is resolved directly: it must
 * be a `ValueEvent` of the node the reference declares, exactly as whole-history
 * validation requires. Resolving an admitted coordinate visits one admitted
 * record and never retained history, so the check stays change-bounded.
 *
 * @param {SemanticEvent} event
 * @param {JournalRecordId} referenceId
 * @param {NodeKey} expectedNode
 * @param {JournalFrontier} frontier
 * @param {AdmittedIndexClass} index
 * @returns {JournalError | undefined}
 */
function validateAdmittedReference(event, referenceId, expectedNode, frontier, index) {
    const label = journalRecordIdToString(event.id);
    if (compareJournalSequence(
        referenceId.sequence,
        journalSequenceAtFrontier(frontier, referenceId.author)
    ) > 0) {
        return makeJournalRecordValidationError("referenced ValueId is not retained", label);
    }
    const resolved = index.recordOf(referenceId);
    if (resolved === undefined) {
        return undefined;
    }
    if (!isValueEvent(resolved)) {
        return makeJournalRecordValidationError(
            "referenced ValueId is not a ValueEvent",
            label
        );
    }
    if (nodeKeyToCanonicalString(resolved.node) !== nodeKeyToCanonicalString(expectedNode)) {
        return makeJournalRecordValidationError(
            "referenced ValueId belongs to another semantic node",
            label
        );
    }
    return undefined;
}

/**
 * Check the self-described references of one admitted record against the
 * admitted change set.
 *
 * A validation names its target occurrence and, for each explicit input, the
 * occurrence it used as that input; a value- or proof-scoped invalidation names
 * the occurrence it retires. Each is a `ValueEvent` of the record's own node (or
 * of the named input) in whole-history well-formedness, so each is resolved here
 * for the coordinates the change set holds.
 *
 * @param {SemanticEvent} event
 * @param {JournalFrontier} frontier
 * @param {AdmittedIndexClass} index
 * @returns {JournalError | undefined}
 */
function validateAdmittedReferences(event, frontier, index) {
    if (isValidateEvent(event)) {
        const target = validateAdmittedReference(event, event.value, event.node, frontier, index);
        if (target !== undefined) {
            return target;
        }
        for (const entry of event.basis) {
            if (entry.value === "unknown") {
                continue;
            }
            const basis = validateAdmittedReference(event, entry.value, entry.input, frontier, index);
            if (basis !== undefined) {
                return basis;
            }
        }
        return undefined;
    }
    if (isInvalidateEvent(event) && event.scope.kind !== "node") {
        return validateAdmittedReference(event, event.scope.value, event.node, frontier, index);
    }
    return undefined;
}

/**
 * Check the transitive closure, authority extension and self-described
 * references of the records one operation admits.
 *
 * This is the relation-shaped half of the bounded validation contract; the
 * per-record half is `validateImportedRecord`. It is evaluated over the complete
 * admitted change set so a record which claims a coordinate of a writer admitted
 * later in the same operation is checked against it, and it visits only admitted
 * records. The union frontier is the receiver's retained lengths joined with the
 * imported suffixes, so a reference the change set does not hold can still be
 * classified as retained-prefix or unretained.
 *
 * @param {ReadonlyArray<JournalRecord>} records
 * @param {JournalFrontier} frontier - The union frontier including every admitted suffix.
 * @returns {JournalError | undefined}
 */
function validateAdmittedRecords(records, frontier) {
    const index = new AdmittedIndexClass();
    for (const record of records) {
        index.add(record);
    }
    for (const record of records) {
        if (!isSemanticEvent(record)) {
            continue;
        }
        const closure = validateAdmittedClosure(record, index);
        if (closure !== undefined) {
            return closure;
        }
        const authority = validateAdmittedAuthority(record, index);
        if (authority !== undefined) {
            return authority;
        }
        const references = validateAdmittedReferences(record, frontier, index);
        if (references !== undefined) {
            return references;
        }
    }
    return undefined;
}

module.exports = {
    validateAdmittedRecords,
    validateImportedRecord,
};
