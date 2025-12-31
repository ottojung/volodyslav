/**
 * Type definitions for DependencyGraph.
 */

/** @typedef {import('../../event').Event} Event */
/** @typedef {import('../database/class').Database} Database */
/** @typedef {import('../database/types').DatabaseValue} DatabaseValue */
/** @typedef {import('../database/types').Freshness} Freshness */
/** @typedef {import('./unchanged').Unchanged} Unchanged */

/**
 * Union type for values that can be stored in the database.
 * @typedef {DatabaseValue | Freshness} DatabaseStoredValue
 */

/**
 * Capabilities needed for DependencyGraph operations
 * @typedef {object} DependencyGraphCapabilities
 * @property {Database} database - A database instance
 */

/**
 * A string constant value.
 * @typedef {object} StringConstant
 * @property {'string'} type - The type of constant
 * @property {string} value - The string value
 */

/**
 * An integer constant value.
 * @typedef {object} IntConstant
 * @property {'int'} type - The type of constant
 * @property {number} value - The integer value
 */

/**
 * A constant value (string or integer).
 * @typedef {StringConstant | IntConstant} ConstValue
 */

/**
 * A computor function for node definitions that receives typed bindings for variables.
 * @typedef {(inputs: Array<DatabaseValue>, oldValue: DatabaseValue | undefined, bindings: Record<string, ConstValue>) => DatabaseValue | Unchanged} NodeDefComputor
 */

/**
 * Unified node definition.
 * @typedef {object} NodeDef
 * @property {string} output - Pattern or exact key (e.g., "event_context(e)" or 'status("active")')
 * @property {Array<string>} inputs - Pattern dependencies
 * @property {NodeDefComputor} computor - Function that computes the output from inputs, old value, and typed bindings
 */

/**
 * Compiled node with cached metadata for efficient matching and instantiation.
 * @typedef {object} CompiledNode
 * @property {NodeDef} source - The original node definition
 * @property {import('./expr').ParsedExpr} outputExpr - Parsed output expression
 * @property {string} canonicalOutput - Canonical form of output
 * @property {Array<import('./expr').ParsedExpr>} inputExprs - Parsed input expressions
 * @property {Array<string>} canonicalInputs - Canonical forms of inputs
 * @property {string} head - Head/name of the output expression
 * @property {number} arity - Number of arguments in output
 * @property {boolean} isPattern - True if output contains variables (unquoted identifiers)
 * @property {Array<'var'|'const'>} outputArgKinds - Kind of each output argument position
 * @property {Array<ConstValue | null>} outputConstArgs - Constant values for each output position (null if variable)
 * @property {Map<string, Array<number>>} repeatedVarPositions - Map from variable name to positions where it appears
 * @property {Set<string>} varsUsedInInputs - Variables used in any input pattern
 */

module.exports = {};
