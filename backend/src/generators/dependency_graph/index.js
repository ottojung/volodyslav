/**
 * DependencyGraph module for generators.
 * Provides an abstraction over the database for managing event dependencies.
 */

const { makeDependencyGraph, isDependencyGraph } = require('./class');
const { makeUnchanged, isUnchanged } = require('./unchanged');
const { 
    makeInvalidNodeError, 
    isInvalidNode,
    makeInvalidSchemaError,
    isInvalidSchema, 
    makeSchemaPatternNotAllowedError, 
    isSchemaPatternNotAllowed,
    makeArityMismatchError,
    isArityMismatch,
    makeInvalidExpressionError,
    isInvalidExpression,
    makeInvalidSetError,
    isInvalidSet,
    makeSchemaCycleError,
    isSchemaCycle,
    makeMissingValueError,
    isMissingValue,
    makeSchemaOverlapError,
    isSchemaOverlap,
} = require('./errors');

/** @typedef {import('./types').DependencyGraphCapabilities} DependencyGraphCapabilities */
/** @typedef {import('./class').DependencyGraph} DependencyGraph */
/** @typedef {import('./unchanged').Unchanged} Unchanged */

module.exports = {
    makeDependencyGraph,
    isDependencyGraph,
    makeUnchanged,
    isUnchanged,
    makeInvalidNodeError,
    isInvalidNode,
    makeInvalidSchemaError,
    isInvalidSchema,
    makeSchemaPatternNotAllowedError,
    isSchemaPatternNotAllowed,
    makeArityMismatchError,
    isArityMismatch,
    makeInvalidExpressionError,
    isInvalidExpression,
    makeInvalidSetError,
    isInvalidSet,
    makeSchemaCycleError,
    isSchemaCycle,
    makeMissingValueError,
    isMissingValue,
    makeSchemaOverlapError,
    isSchemaOverlap,
};
