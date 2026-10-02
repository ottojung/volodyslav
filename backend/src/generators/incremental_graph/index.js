/**
 * IncrementalGraph module for generators.
 * Provides an abstraction over the database for managing event dependencies.
 */

const { createIncrementalGraph, isIncrementalGraph } = require('./class');
const { makeUnchanged, isUnchanged } = require('./unchanged');
const { 
    makeInvalidNodeError, 
    isInvalidNode,
    makeInvalidNodeNameError,
    isInvalidNodeName,
    makeInvalidSchemaError,
    isInvalidSchema, 
    makeSchemaPatternNotAllowedError, 
    isSchemaPatternNotAllowed,
    makeArityMismatchError,
    isArityMismatch,
    makeInvalidExpressionError,
    isInvalidExpression,
    makeSchemaCycleError,
    isSchemaCycle,
    makeSchemaOverlapError,
    isSchemaOverlap,
    makeInvalidUnchangedError,
    isInvalidUnchanged,
    makeSchemaArityConflictError,
    isSchemaArityConflict,
    makeInvalidNodeDefError,
    isInvalidNodeDef,
    makeMissingTimestampError,
    isMissingTimestamp,
} = require('./errors');
const { makeRootDatabase, getRootDatabase, LIVE_DATABASE_WORKING_PATH, CHECKPOINT_WORKING_PATH } = require('./database');
const { makeMigrationStorage, isMigrationStorage } = require('./migration_storage');
const { runMigration, runMigrationUnsafe } = require('./migration_runner');
const { holidayActivity } = require('./lock');
const {
    makeDecisionConflictError,
    isDecisionConflict,
    makeOverrideConflictError,
    isOverrideConflict,
    makeUndecidedNodesError,
    isUndecidedNodes,
    makeSchemaCompatibilityError,
    isSchemaCompatibility,
    makeGetMissingNodeError,
    isGetMissingNode,
    makeMissingDependencyMetadataError,
    isMissingDependencyMetadata,
    makeCreateExistingNodeError,
    isCreateExistingNode,
} = require('./migration_errors');
const { migrationCallback } = require('./migration');
const { synchronizeNoLock, restoreAbsentFrom, AbsentRestoreError, isAbsentRestoreError } = require('./database');
const {
    encodeJournalRecord,
    journalRecordIdToString,
    makeReplicaSource,
    projectRetainedJournal,
    validateJournalReplica,
} = require('./journal');
const {
    makeJournalOccurrenceKey,
    makeJournalRecordKey,
    readCommittedWriterState,
    readRetainedJournal,
    serializeWriterState,
} = require('./journal_store');

/**
 * The Journal's own vocabulary, which an absent-installation restoration reads
 * its held snapshot through.
 *
 * `database/restore_absent` reaches the Journal through this value rather than
 * through its own `require`s, because every Journal module reaches this folder's
 * index for the shared key vocabulary: a `database/` module which required one
 * of them directly would be required while that index is still initialising,
 * and would observe a half-built export object.
 */
const journalRestoration = {
    encodeJournalRecord,
    journalRecordIdToString,
    makeJournalOccurrenceKey,
    makeJournalRecordKey,
    makeReplicaSource,
    projectRetainedJournal,
    readCommittedWriterState,
    readRetainedJournal,
    serializeWriterState,
    validateJournalReplica,
};

const { prepareIncrementalGraphStorage } = require('./prepare_graph_storage');

/** @typedef {import('./types').IncrementalGraphCapabilities} IncrementalGraphCapabilities */
/** @typedef {import('./class').IncrementalGraph} IncrementalGraph */
/** @typedef {import('./unchanged').Unchanged} Unchanged */

module.exports = {
    makeRootDatabase,
    getRootDatabase,
    LIVE_DATABASE_WORKING_PATH,
    CHECKPOINT_WORKING_PATH,
    createIncrementalGraph,
    isIncrementalGraph,
    makeUnchanged,
    isUnchanged,
    makeInvalidNodeError,
    isInvalidNode,
    makeInvalidNodeNameError,
    isInvalidNodeName,
    makeInvalidSchemaError,
    isInvalidSchema,
    makeSchemaPatternNotAllowedError,
    isSchemaPatternNotAllowed,
    makeArityMismatchError,
    isArityMismatch,
    makeInvalidExpressionError,
    isInvalidExpression,
    makeSchemaCycleError,
    isSchemaCycle,
    makeSchemaOverlapError,
    isSchemaOverlap,
    makeInvalidUnchangedError,
    isInvalidUnchanged,
    makeSchemaArityConflictError,
    isSchemaArityConflict,
    makeInvalidNodeDefError,
    isInvalidNodeDef,
    makeMissingTimestampError,
    isMissingTimestamp,
    // Migration API
    makeMigrationStorage,
    isMigrationStorage,
    runMigration,
    runMigrationUnsafe,
    makeDecisionConflictError,
    isDecisionConflict,
    makeOverrideConflictError,
    isOverrideConflict,
    makeUndecidedNodesError,
    isUndecidedNodes,
    makeSchemaCompatibilityError,
    isSchemaCompatibility,
    makeGetMissingNodeError,
    isGetMissingNode,
    makeMissingDependencyMetadataError,
    isMissingDependencyMetadata,
    makeCreateExistingNodeError,
    isCreateExistingNode,
    holidayActivity,
    migrationCallback,
    synchronizeNoLock,
    journalRestoration,
    restoreAbsentFrom,
    AbsentRestoreError,
    isAbsentRestoreError,
    prepareIncrementalGraphStorage,
};
