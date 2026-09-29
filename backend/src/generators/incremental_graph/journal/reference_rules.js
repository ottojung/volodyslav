/**
 * Cross-record reference rules.
 *
 * Every ValueId a record names must be a retained `ValueEvent` for the same
 * semantic node which the referencing record had causally observed. A record
 * which names a concurrent, future, or other-node occurrence is rejected; the
 * referenced occurrence is never substituted and no part of the event is
 * salvaged.
 *
 * The two failure categories are kept apart:
 *
 * - a reference which names the wrong kind of record, a record which is not
 *   retained, or a different semantic node, is a
 *   `JournalRecordValidationError`;
 * - a reference which names a retained value occurrence the referencing record
 *   had not observed is a `JournalReferenceCausalityError`.
 */

const {
    makeJournalRecordValidationError,
    makeJournalReferenceCausalityError,
} = require("./errors");
const { isBaselineValidationReason } = require("./basis");
const { happenedBefore } = require("./ordering");
const { recordAtSequence } = require("./replica");
const {
    isInvalidateEvent,
    isValidateEvent,
    isValueEvent,
    isWriterStateRecord,
} = require("./records");
const {
    compareJournalSequence,
    isSameJournalAuthor,
    journalRecordIdToString,
} = require("./types");
const { nodeKeyToCanonicalString } = require("./basis");

/** @typedef {import('./errors').AnyJournalError} JournalError */
/** @typedef {import('./records').InvalidateEvent} InvalidateEvent */
/** @typedef {import('./records').JournalRecord} JournalRecord */
/** @typedef {import('./records').ValidateEvent} ValidateEvent */
/** @typedef {import('./records').ValueEvent} ValueEvent */
/** @typedef {import('./replica').JournalReplica} JournalReplica */
/** @typedef {import('./types').JournalRecordId} JournalRecordId */
/** @typedef {import('./types').NodeKey} NodeKey */

/**
 * The current-schema direct inputs of a node, keyed by canonical persisted
 * NodeKey identity. A node which is not in the current schema has no entry.
 * @callback CurrentInputKeysOfNode
 * @param {string} nodeKeyString - Canonical persisted NodeKey identity.
 * @returns {ReadonlyArray<string> | undefined} Canonical identities of the current direct inputs.
 */

/**
 * @typedef {object} ReferenceResolution
 * @property {true} ok
 * @property {ValueEvent} valueEvent
 */

/**
 * Resolve a named ValueId to the retained ValueEvent it denotes, applying the
 * two rules which belong to record validity rather than to causality.
 * @param {JournalRecordId} referenceId
 * @param {NodeKey} referenceNode - The semantic node the reference is made from.
 * @param {JournalRecordId} value
 * @param {JournalReplica} replica
 * @returns {ReferenceResolution | {ok: false, error: JournalError}}
 */
function resolveValueEvent(referenceId, referenceNode, value, replica) {
    const label = journalRecordIdToString(referenceId);
    const record = recordAtSequence(replica, value.author, value.sequence);
    if (record === undefined) {
        return {
            ok: false,
            error: makeJournalRecordValidationError("referenced ValueId is not retained", label),
        };
    }
    if (!isValueEvent(record)) {
        return {
            ok: false,
            error: makeJournalRecordValidationError(
                "referenced ValueId is not a ValueEvent",
                label
            ),
        };
    }
    if (nodeKeyToCanonicalString(record.node) !== nodeKeyToCanonicalString(referenceNode)) {
        return {
            ok: false,
            error: makeJournalRecordValidationError(
                "referenced ValueId belongs to another semantic node",
                label
            ),
        };
    }
    return { ok: true, valueEvent: record };
}

/**
 * A record cannot reference a value occurrence it had not causally observed.
 * @param {import('./ordering').ContextualRecord} event
 * @param {JournalRecordId} value
 * @param {JournalReplica} replica
 * @returns {JournalError | undefined}
 */
function requireObservedValue(event, value, replica) {
    const target = recordAtSequence(replica, value.author, value.sequence);
    if (target === undefined || !isValueEvent(target)) {
        return undefined;
    }
    if (happenedBefore(target, event)) {
        return undefined;
    }
    return makeJournalReferenceCausalityError(
        journalRecordIdToString(event.id),
        journalRecordIdToString(value),
        "the referenced occurrence is concurrent with, or later than, the referencing event"
    );
}

/**
 * The validation target rule: the target is a retained ValueEvent for the same
 * node which happened-before the validation.
 * @param {ValidateEvent} event
 * @param {JournalReplica} replica
 * @returns {JournalError | undefined}
 */
function validateTarget(event, replica) {
    const resolved = resolveValueEvent(event.id, event.node, event.value, replica);
    if (!resolved.ok) {
        return resolved.error;
    }
    return requireObservedValue(event, event.value, replica);
}

/**
 * The basis rules: every non-`"unknown"` entry names a retained ValueEvent for
 * that exact input which happened-before the validation.
 * @param {ValidateEvent} event
 * @param {JournalReplica} replica
 * @returns {JournalError | undefined}
 */
function validateBasisValues(event, replica) {
    for (const entry of event.basis) {
        if (entry.value === "unknown") {
            continue;
        }
        const resolved = resolveValueEvent(event.id, entry.input, entry.value, replica);
        if (!resolved.ok) {
            return resolved.error;
        }
        const observed = requireObservedValue(
            { id: event.id, context: event.context },
            entry.value,
            replica
        );
        if (observed !== undefined) {
            return observed;
        }
    }
    return undefined;
}

/**
 * The reason rule, which is a property of the certificate itself: an ordinary
 * compute, unchanged or cache-revalidate certificate uses no `"unknown"` entry,
 * because only the controlled baseline reasons may claim that an input's
 * occurrence is not established. Nothing about the current schema enters here, so
 * this rule holds for the whole of history whatever the schema later becomes.
 * @param {ValidateEvent} event
 * @returns {JournalError | undefined}
 */
function validateOrdinaryBasisReasons(event) {
    const label = journalRecordIdToString(event.id);
    if (isBaselineValidationReason(event.reason)) {
        return undefined;
    }
    for (const entry of event.basis) {
        if (entry.value === "unknown") {
            return makeJournalRecordValidationError(
                'reason ' + event.reason + ' must not use an "unknown" basis entry',
                label
            );
        }
    }
    return undefined;
}

/**
 * The current-shape rule: a certificate is current-shape-compatible proof only
 * when its explicit input set is exactly the current direct input set of its
 * node.
 *
 * This is a question about one certificate against the current schema, not a
 * question about whether retained history is intelligible, so it is deliberately
 * *not* part of whole-history well-formedness. A historical certificate whose
 * explicit input set no longer equals the current schema's input set, and a
 * certificate on a node family the current schema has removed, remain
 * structurally intelligible history; applying this rule to a retained history
 * would report exactly that history as corruption. Replay applies it per
 * certificate when it decides which candidate is eligible, and an authoring
 * transition applies it before it writes a new certificate.
 * @param {ValidateEvent} event
 * @param {CurrentInputKeysOfNode} currentInputKeysOfNode
 * @returns {JournalError | undefined}
 */
function validateCurrentShapeBasis(event, currentInputKeysOfNode) {
    const label = journalRecordIdToString(event.id);
    if (isBaselineValidationReason(event.reason)) {
        return undefined;
    }
    const nodeKeyString = nodeKeyToCanonicalString(event.node);
    const current = currentInputKeysOfNode(nodeKeyString);
    if (current === undefined) {
        return makeJournalRecordValidationError(
            "node " + nodeKeyString + " is not part of the current schema",
            label
        );
    }
    const declared = event.basis
        .map((entry) => nodeKeyToCanonicalString(entry.input))
        .sort();
    const expected = current.slice().sort();
    if (declared.join(",") !== expected.join(",")) {
        return makeJournalRecordValidationError(
            "validation basis does not name exactly the current direct input set",
            label
        );
    }
    return undefined;
}

/**
 * The value-/proof-scoped invalidation rule: the named occurrence is a retained
 * ValueEvent for the same node which happened-before the invalidation. A proof
 * barrier's input NodeKey shape and its maintenance-only reason are current
 * format rules, already enforced when the record is built; the authoring
 * obligation that the barrier retired exactly that edge is not expressible from
 * the record and belongs to the lifecycle transition which authored it.
 * @param {InvalidateEvent} event
 * @param {JournalReplica} replica
 * @returns {JournalError | undefined}
 */
function validateInvalidationScope(event, replica) {
    const scope = event.scope;
    if (scope.kind === "node") {
        return undefined;
    }
    const resolved = resolveValueEvent(event.id, event.node, scope.value, replica);
    if (!resolved.ok) {
        return resolved.error;
    }
    return requireObservedValue(event, scope.value, replica);
}

/**
 * Within one writer publication a record may not reference a coordinate the same
 * writer allocates later.
 * @param {JournalRecord} record
 * @returns {JournalError | undefined}
 */
function validateNoForwardOwnWriterReference(record) {
    const label = journalRecordIdToString(record.id);
    if (isWriterStateRecord(record) || !isValidateEvent(record) && !isInvalidateEvent(record)) {
        return undefined;
    }
    if (isValidateEvent(record)) {
        return validateNoForwardReference(label, record.id, record.value);
    }
    if (record.scope.kind === "node") {
        return undefined;
    }
    return validateNoForwardReference(label, record.id, record.scope.value);
}

/**
 * @param {string} label
 * @param {JournalRecordId} recordId
 * @param {JournalRecordId} referenced
 * @returns {JournalError | undefined}
 */
function validateNoForwardReference(label, recordId, referenced) {
    if (!isSameJournalAuthor(referenced.author, recordId.author)) {
        return undefined;
    }
    if (compareJournalSequence(referenced.sequence, recordId.sequence) < 0) {
        return undefined;
    }
    return makeJournalReferenceCausalityError(
        label,
        journalRecordIdToString(referenced),
        "a publication may not contain a forward reference to its own writer"
    );
}

module.exports = {
    requireObservedValue,
    resolveValueEvent,
    validateBasisValues,
    validateCurrentShapeBasis,
    validateInvalidationScope,
    validateNoForwardOwnWriterReference,
    validateOrdinaryBasisReasons,
    validateTarget,
};
