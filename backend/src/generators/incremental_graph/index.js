/**
 * IncrementalGraph module for generators.
 * Provides an abstraction over the database for managing event dependencies.
 */

const { makeIncrementalGraph, isIncrementalGraph } = require('./class');
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
} = require('./errors');
const { makeRootDatabase, getRootDatabase } = require('./database');
const { makeMigrationStorage, isMigrationStorage } = require('./migration_storage');
const { runMigration } = require('./migration_runner');
const {
    makeDecisionConflictError,
    isDecisionConflict,
    makeOverrideConflictError,
    isOverrideConflict,
    makeUndecidedNodesError,
    isUndecidedNodes,
    makePartialDeleteFanInError,
    isPartialDeleteFanIn,
    makeSchemaCompatibilityError,
    isSchemaCompatibility,
    makeGetMissingNodeError,
    isGetMissingNode,
    makeGetMissingValueError,
    isGetMissingValue,
    makeMissingDependencyMetadataError,
    isMissingDependencyMetadata,
    makeCreateExistingNodeError,
    isCreateExistingNode,
} = require('./migration_errors');

/** @typedef {import('./types').IncrementalGraphCapabilities} IncrementalGraphCapabilities */
/** @typedef {import('./class').IncrementalGraph} IncrementalGraph */
/** @typedef {import('./unchanged').Unchanged} Unchanged */

module.exports = {
    makeRootDatabase,
    getRootDatabase,
    makeIncrementalGraph,
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
    // Migration API
    makeMigrationStorage,
    isMigrationStorage,
    runMigration,
    makeDecisionConflictError,
    isDecisionConflict,
    makeOverrideConflictError,
    isOverrideConflict,
    makeUndecidedNodesError,
    isUndecidedNodes,
    makePartialDeleteFanInError,
    isPartialDeleteFanIn,
    makeSchemaCompatibilityError,
    isSchemaCompatibility,
    makeGetMissingNodeError,
    isGetMissingNode,
    makeGetMissingValueError,
    isGetMissingValue,
    makeMissingDependencyMetadataError,
    isMissingDependencyMetadata,
    makeCreateExistingNodeError,
    isCreateExistingNode,
};
