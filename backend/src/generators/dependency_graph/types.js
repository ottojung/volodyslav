/**
 * Type definitions for DependencyGraph.
 */

/** @typedef {import('../../event').Event} Event */
/** @typedef {import('../database/root_database').RootDatabase} RootDatabase */
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
 * @property {RootDatabase} database - A root database instance
 */

/**
 * A computor function for node definitions.
 * Receives inputs, optional old value, and bindings for any variables in the pattern.
 * @typedef {(inputs: Array<DatabaseValue>, oldValue: DatabaseValue | undefined, bindings: Record<string, DatabaseValue>) => DatabaseValue | Unchanged} NodeDefComputor
 */

/**
 * Simpler computor without bindings parameter (used for concrete instantiated nodes).
 * @typedef {(inputs: Array<DatabaseValue>, oldValue: DatabaseValue | undefined) => DatabaseValue | Unchanged} ConcreteNodeComputor
 */

/**
 * A concrete node definition with resolved inputs and output.
 * Used for runtime instantiations of pattern nodes.
 * @typedef {object} ConcreteNodeDefinition
 * @property {string} output - Canonical concrete output key
 * @property {Array<string>} inputs - Array of canonical concrete input keys
 * @property {ConcreteNodeComputor} computor - Function that computes the output from inputs and old value
 */

/**
 * Status returned after recomputing a node value.
 * - 'changed': Value was recomputed and differs from old value
 * - 'unchanged': Value was recomputed but equals old value
 * - 'cached': Value was not recomputed, returned from cache
 * @typedef {'changed' | 'unchanged' | 'cached'} RecomputeStatus
 */

/**
 * Result of a recompute operation.
 * @typedef {object} RecomputeResult
 * @property {DatabaseValue} value - The computed or cached value
 * @property {RecomputeStatus} status - Status of the operation
 */

/**
 * Extended freshness status including missing state.
 * @typedef {'up-to-date' | 'potentially-outdated' | 'missing'} FreshnessStatus
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
 * @property {Array<'identifier' | 'string' | 'number'>} outputArgKinds - Kind of each output argument position
 * @property {Map<string, Array<number>>} repeatedVarPositions - Map from variable name to positions where it appears
 * @property {Set<string>} varsUsedInInputs - Variables used in any input pattern
 */

module.exports = {};
