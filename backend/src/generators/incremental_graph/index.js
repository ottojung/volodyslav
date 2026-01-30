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
    makeInvalidBindingsError,
    isInvalidBindings,
    makeInvalidExpressionError,
    isInvalidExpression,
    makeSchemaCycleError,
    isSchemaCycle,
    makeMissingValueError,
    isMissingValue,
    makeSchemaOverlapError,
    isSchemaOverlap,
    makeInvalidUnchangedError,
    isInvalidUnchanged,
    makeSchemaArityConflictError,
    isSchemaArityConflict,
} = require('./errors');

/** @typedef {import('./types').IncrementalGraphCapabilities} IncrementalGraphCapabilities */
/** @typedef {import('./class').IncrementalGraph} IncrementalGraph */
/** @typedef {import('./unchanged').Unchanged} Unchanged */

module.exports = {
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
    makeInvalidBindingsError,
    isInvalidBindings,
    makeInvalidExpressionError,
    isInvalidExpression,
    makeSchemaCycleError,
    isSchemaCycle,
    makeMissingValueError,
    isMissingValue,
    makeSchemaOverlapError,
    isSchemaOverlap,
    makeInvalidUnchangedError,
    isInvalidUnchanged,
    makeSchemaArityConflictError,
    isSchemaArityConflict,
};
