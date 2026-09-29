/**
 * The Journal 3 record layer.
 *
 * This module is the only import point of the `journal` subfolder. Everything
 * below it is a pure, in-memory layer: it owns the record vocabulary, the
 * canonical current-format codec, and the well-formedness rules. It performs no
 * I/O, holds no locks, and has no lifecycle.
 */

// Errors
const {
    JournalError,
    isJournalError,
    makeJournalForkError,
    isJournalForkError,
    makeJournalBootstrapForkError,
    isJournalBootstrapForkError,
    makeJournalGapError,
    isJournalGapError,
    makeJournalCausalClosureError,
    isJournalCausalClosureError,
    makeJournalReferenceCausalityError,
    isJournalReferenceCausalityError,
    makeJournalRecordValidationError,
    isJournalRecordValidationError,
    makeJournalVersionCompatibilityError,
    isJournalVersionCompatibilityError,
    makeJournalWriterBehindError,
    isJournalWriterBehindError,
    makeJournalProjectionError,
    isJournalProjectionError,
    makeJournalPublicationError,
    isJournalPublicationError,
    makeJournalSourceReadError,
    isJournalSourceReadError,
} = require("./errors");

// Identities, authority and frontiers
const {
    ZERO_JOURNAL_SEQUENCE,
    compareAuthorityTime,
    compareJournalSequence,
    frontierJoin,
    isAuthorityTime,
    isJournalAuthor,
    isJournalFrontier,
    isJournalRecordId,
    isJournalSequence,
    isSameJournalAuthor,
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceAtFrontier,
    journalSequenceToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontier,
    makeJournalFrontierFromText,
    makeJournalRecordId,
    makeJournalSequence,
    parseJournalRecordId,
} = require("./types");

const { predecessorJournalSequence, requireSuccessorJournalSequence, successorJournalSequence } = require("./coordinates");

const { authorityCompare, happenedBefore } = require("./ordering");

// Validation basis and invalidation scopes
const {
    isBaselineValidationReason,
    isInvalidateScope,
    isNodeKey,
    isValidationBasisEntry,
    nodeKeyToCanonicalString,
    makeNodeScope,
    makeProofScope,
    makeValidationBasisEntry,
    makeValueScope,
    sortValidationBasis,
} = require("./basis");

// Record classes
const {
    DELETE_REASONS,
    INVALIDATE_REASONS,
    VALIDATE_REASONS,
    VALUE_REASONS,
    isDeleteEvent,
    isInvalidateEvent,
    isJournalRecord,
    isSemanticEvent,
    isValidateEvent,
    isValueEvent,
    isWriterStateRecord,
    makeDeleteEvent,
    makeInvalidateEvent,
    makeValidateEvent,
    makeValueEvent,
    makeWriterStateRecord,
} = require("./records");

// Canonical current-format codec
const {
    canonicalRecordBody,
    currentFormatDecodeRecord,
    currentFormatValidateRecord,
    encodeJournalRecord,
    tryDecodeJournalRecord,
} = require("./codec");

// Retained replica
const {
    isJournalReplica,
    makeJournalReplica,
    recordAtSequence,
    recordsUpToSequence,
    replicaFrontier,
    semanticEventsOfReplica,
    semanticEventsUpToSequence,
    streamOf,
} = require("./replica");

// Well-formedness
const {
    joinReplicaRecords,
    validateJournalReplica,
    validateRecordReferences,
    validateSameIdentityAgreement,
    validateStreamContiguity,
    validateWriterStateMonotonicity,
} = require("./well_formedness");

const {
    validateAuthorityExtension,
    validateCausalContextClosure,
    validateCompleteLocalPrefix,
    validateEventContext,
    validateRetainedRangeCoverage,
    validateTransitiveClosure,
} = require("./context_closure");

const {
    requireObservedValue,
    resolveValueEvent,
    validateBasisValues,
    validateInvalidationScope,
    validateCurrentShapeBasis,
    validateNoForwardOwnWriterReference,
    validateOrdinaryBasisReasons,
    validateTarget,
} = require("./reference_rules");

// Ordinary emission finalization
const { finalizeEmission } = require("./emission");

/** @typedef {import('./errors').AnyJournalError} AnyJournalError */
/** @typedef {import('./basis').InvalidateScope} InvalidateScope */
/** @typedef {import('./basis').ValidationBasis} ValidationBasis */
/** @typedef {import('./basis').ValidationBasisEntry} ValidationBasisEntry */
/** @typedef {import('./ordering').CausalEventRef} CausalEventRef */
/** @typedef {import('./records').DeleteEvent} DeleteEvent */
/** @typedef {import('./records').InvalidateEvent} InvalidateEvent */
/** @typedef {import('./records').JournalRecord} JournalRecord */
/** @typedef {import('./records').SemanticEvent} SemanticEvent */
/** @typedef {import('./records').ValidateEvent} ValidateEvent */
/** @typedef {import('./records').ValueEvent} ValueEvent */
/** @typedef {import('./records').WriterStateRecord} WriterStateRecord */
/** @typedef {import('./emission').EmissionIntent} EmissionIntent */
/** @typedef {import('./emission').MaterializeIntent} MaterializeIntent */
/** @typedef {import('./emission').MaterializeInput} MaterializeInput */
/** @typedef {import('./emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('./emission').EmissionRequest} EmissionRequest */
/** @typedef {import('./emission').FinalizedPublication} FinalizedPublication */
/** @typedef {import('./replica').JournalReplica} JournalReplica */
/** @typedef {import('./reference_rules').CurrentInputKeysOfNode} CurrentInputKeysOfNode */
/** @typedef {import('./types').AuthorityTime} AuthorityTime */
/** @typedef {import('./types').JournalAuthor} JournalAuthor */
/** @typedef {import('./types').JournalFrontier} JournalFrontier */
/** @typedef {import('./types').JournalRecordId} JournalRecordId */
/** @typedef {import('./types').JournalSequence} JournalSequence */
/** @typedef {import('../database/node_key').NodeKey} NodeKey */

module.exports = {
    authorityCompare,
    DELETE_REASONS,
    INVALIDATE_REASONS,
    JournalError,
    VALIDATE_REASONS,
    VALUE_REASONS,
    ZERO_JOURNAL_SEQUENCE,
    canonicalRecordBody,
    compareAuthorityTime,
    compareJournalSequence,
    currentFormatDecodeRecord,
    currentFormatValidateRecord,
    encodeJournalRecord,
    finalizeEmission,
    frontierJoin,
    happenedBefore,
    isAuthorityTime,
    isBaselineValidationReason,
    isDeleteEvent,
    isInvalidateEvent,
    isInvalidateScope,
    isJournalAuthor,
    isJournalError,
    isJournalForkError,
    isJournalFrontier,
    isJournalRecord,
    isJournalRecordId,
    isJournalReplica,
    isJournalSequence,
    isNodeKey,
    isSameJournalAuthor,
    isSemanticEvent,
    isValidateEvent,
    isValidationBasisEntry,
    isValueEvent,
    isWriterStateRecord,
    joinReplicaRecords,
    makeAuthorityTime,
    makeDeleteEvent,
    makeInvalidateEvent,
    makeJournalAuthor,
    makeJournalFrontier,
    makeJournalFrontierFromText,
    makeJournalRecordId,
    makeJournalReplica,
    makeJournalSequence,
    makeNodeScope,
    makeProofScope,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    makeValueScope,
    makeWriterStateRecord,
    nodeKeyToCanonicalString,
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceAtFrontier,
    journalSequenceToString,
    parseJournalRecordId,
    predecessorJournalSequence,
    requireSuccessorJournalSequence,
    successorJournalSequence,
    recordAtSequence,
    recordsUpToSequence,
    replicaFrontier,
    requireObservedValue,
    resolveValueEvent,
    semanticEventsOfReplica,
    semanticEventsUpToSequence,
    sortValidationBasis,
    streamOf,
    tryDecodeJournalRecord,
    validateAuthorityExtension,
    validateBasisValues,
    validateCausalContextClosure,
    validateCompleteLocalPrefix,
    validateCurrentShapeBasis,
    validateEventContext,
    validateInvalidationScope,
    validateJournalReplica,
    validateNoForwardOwnWriterReference,
    validateOrdinaryBasisReasons,
    validateRecordReferences,
    validateRetainedRangeCoverage,
    validateSameIdentityAgreement,
    validateStreamContiguity,
    validateTarget,
    validateTransitiveClosure,
    validateWriterStateMonotonicity,
    makeJournalBootstrapForkError,
    makeJournalCausalClosureError,
    makeJournalForkError,
    makeJournalGapError,
    makeJournalProjectionError,
    makeJournalPublicationError,
    makeJournalRecordValidationError,
    makeJournalReferenceCausalityError,
    makeJournalSourceReadError,
    makeJournalVersionCompatibilityError,
    makeJournalWriterBehindError,
    isJournalBootstrapForkError,
    isJournalCausalClosureError,
    isJournalGapError,
    isJournalProjectionError,
    isJournalPublicationError,
    isJournalRecordValidationError,
    isJournalReferenceCausalityError,
    isJournalSourceReadError,
    isJournalVersionCompatibilityError,
    isJournalWriterBehindError,
};
