/**
 * Journal well-formedness: the structural, causal and cross-record conditions a
 * retained journal must satisfy before it may be treated as supported replay
 * input.
 *
 * Every rule here is a pure function over an in-memory `JournalReplica`. None
 * of them repairs history, merges a conflict, or reorders anything: a violated
 * rule is reported as the error the Journal taxonomy names, and the caller
 * decides the lifecycle consequence.
 *
 * Malformed history is never converted into a normal graph conflict, even where
 * deterministic replay could have chosen a winner.
 */

const {
    makeJournalForkError,
    makeJournalGapError,
    makeJournalRecordValidationError,
} = require("./errors");
const { encodeJournalRecord } = require("./codec");
const { validateCausalContextClosure } = require("./context_closure");
const {
    validateBasisValues,
    validateInvalidationScope,
    validateNoForwardOwnWriterReference,
    validateOrdinaryBasis,
    validateTarget,
} = require("./reference_rules");
const {
    isJournalReplica,
    makeJournalReplica,
    replicaFrontier,
    streamOf,
} = require("./replica");
const {
    isInvalidateEvent,
    isValidateEvent,
    isWriterStateRecord,
} = require("./records");
const {
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceToString,
    makeJournalSequence,
    compareJournalSequence,
} = require("./types");

/** @typedef {import('./errors').AnyJournalError} JournalError */
/** @typedef {import('./reference_rules').CurrentInputKeysOfNode} CurrentInputKeysOfNode */
/** @typedef {import('./replica').JournalReplica} JournalReplica */
/** @typedef {import('./records').JournalRecord} JournalRecord */
/** @typedef {import('./types').JournalAuthor} JournalAuthor */
/** @typedef {import('./types').JournalSequence} JournalSequence */

/**
 * A writer's retained records exist exactly at `A:1 .. A:q`, with no durable
 * hole. A stream is stored in writer-stream order, so contiguity is exactly
 * "the record at position i has sequence i+1".
 * @param {JournalReplica} replica
 * @returns {JournalError | undefined}
 */
function validateStreamContiguity(replica) {
    for (const stream of replica) {
        const author = stream[0];
        const records = stream[1];
        for (let position = 0; position < records.length; position++) {
            const record = records[position];
            if (record === undefined) {
                continue;
            }
            const expected = makeJournalSequence(String(position + 1));
            if (expected instanceof Error) {
                return makeJournalGapError(
                    journalAuthorToString(author),
                    journalSequenceToString(record.id.sequence),
                    String(position + 1)
                );
            }
            if (compareJournalSequence(record.id.sequence, expected) !== 0) {
                return makeJournalGapError(
                    journalAuthorToString(author),
                    journalSequenceToString(record.id.sequence),
                    String(position + 1)
                );
            }
        }
    }
    return undefined;
}

/**
 * Two records with one `JournalRecordId` must have identical canonical
 * current-format meaning. Disagreement is a writer fork, not a graph conflict.
 * @param {JournalRecord} first
 * @param {JournalRecord} second
 * @returns {JournalError | undefined}
 */
function validateSameIdentityAgreement(first, second) {
    const firstMeaning = encodeJournalRecord(first);
    const secondMeaning = encodeJournalRecord(second);
    if (firstMeaning === secondMeaning) {
        return undefined;
    }
    return makeJournalForkError(
        journalRecordIdToString(first.id),
        firstMeaning,
        secondMeaning
    );
}

/**
 * Within one continuing writer stream the allocator watermark is monotone
 * nondecreasing, and replay rejects a decrease. Only the retained stream
 * participates: continuation-safe absent restoration may discard an
 * unrecoverable suffix before this check.
 * @param {JournalReplica} replica
 * @returns {JournalError | undefined}
 */
function validateWriterStateMonotonicity(replica) {
    for (const stream of replica) {
        /** @type {number | undefined} */
        let previous;
        for (const record of stream[1]) {
            if (!isWriterStateRecord(record)) {
                continue;
            }
            if (previous !== undefined && record.lastNodeIndex < previous) {
                return makeJournalRecordValidationError(
                    "writer state lastNodeIndex decreases from " +
                        String(previous) +
                        " to " +
                        String(record.lastNodeIndex),
                    journalRecordIdToString(record.id)
                );
            }
            previous = record.lastNodeIndex;
        }
    }
    return undefined;
}

/**
 * Union two retained prefixes. Compatible states are prefix-comparable with
 * agreeing overlap, so the union is the componentwise maximum; a coordinate
 * where the two retained histories disagree is a fork, which is reported instead
 * of being resolved.
 * @param {JournalReplica} left
 * @param {JournalReplica} right
 * @returns {JournalReplica | JournalError}
 */
function joinReplicaRecords(left, right) {
    /** @type {Array<[JournalAuthor, Array<JournalRecord>]>} */
    const streams = [];
    const authors = new Set([...left.keys(), ...right.keys()]);
    for (const author of authors) {
        const leftStream = streamOf(left, author);
        const rightStream = streamOf(right, author);
        /** @type {Array<JournalRecord>} */
        const merged = [];
        const length = Math.max(leftStream.length, rightStream.length);
        for (let position = 0; position < length; position++) {
            const leftRecord = leftStream[position];
            const rightRecord = rightStream[position];
            if (leftRecord === undefined) {
                if (rightRecord !== undefined) {
                    merged.push(rightRecord);
                }
                continue;
            }
            if (rightRecord === undefined) {
                merged.push(leftRecord);
                continue;
            }
            const disagreement = validateSameIdentityAgreement(leftRecord, rightRecord);
            if (disagreement !== undefined) {
                return disagreement;
            }
            merged.push(leftRecord);
        }
        streams.push([author, merged]);
    }
    return makeJournalReplica(streams);
}

/**
 * The per-record reference rules of one retained record.
 * @param {JournalRecord} record
 * @param {JournalReplica} replica
 * @param {CurrentInputKeysOfNode | undefined} currentInputKeysOfNode
 * @returns {JournalError | undefined}
 */
function validateRecordReferences(record, replica, currentInputKeysOfNode) {
    const forward = validateNoForwardOwnWriterReference(record);
    if (forward !== undefined) {
        return forward;
    }
    if (isValidateEvent(record)) {
        return validateTarget(record, replica) ??
            validateBasisValues(record, replica) ??
            (currentInputKeysOfNode === undefined
                ? undefined
                : validateOrdinaryBasis(record, currentInputKeysOfNode));
    }
    if (isInvalidateEvent(record)) {
        return validateInvalidationScope(record, replica);
    }
    return undefined;
}

/**
 * The optional inputs of a full replica validation.
 * @typedef {object} ValidationOptions
 * @property {CurrentInputKeysOfNode} [currentInputKeysOfNode] - The current
 *   schema's direct inputs per node. Supplied by every validation which claims
 *   current-shape compatibility.
 */

/**
 * Validate a retained replica against every well-formedness rule.
 *
 * The rules are applied in dependency order: a hole would make every later
 * coordinate lookup meaningless, and a fork would make every later comparison of
 * retained meaning meaningless.
 * @param {JournalReplica} replica
 * @param {ValidationOptions} [options]
 * @returns {JournalError | undefined}
 */
function validateJournalReplica(replica, options) {
    if (!isJournalReplica(replica)) {
        return makeJournalRecordValidationError("replica is not a journal replica", "unknown");
    }
    const contiguity = validateStreamContiguity(replica);
    if (contiguity !== undefined) {
        return contiguity;
    }
    const monotonicity = validateWriterStateMonotonicity(replica);
    if (monotonicity !== undefined) {
        return monotonicity;
    }
    const currentInputKeysOfNode = options === undefined ? undefined : options.currentInputKeysOfNode;
    for (const stream of replica) {
        for (const record of stream[1]) {
            const references = validateRecordReferences(record, replica, currentInputKeysOfNode);
            if (references !== undefined) {
                return references;
            }
        }
    }
    return validateCausalContextClosure(replica, replicaFrontier(replica));
}

module.exports = {
    joinReplicaRecords,
    validateJournalReplica,
    validateRecordReferences,
    validateSameIdentityAgreement,
    validateStreamContiguity,
    validateWriterStateMonotonicity,
};
