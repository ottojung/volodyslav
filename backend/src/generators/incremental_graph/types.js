/**
 * Type definitions for IncrementalGraph.
 */

/** @typedef {import('../../event').Event} Event */
/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').Freshness} Freshness */
/** @typedef {import('./unchanged').Unchanged} Unchanged */

/**
 * Serializable value type for bindings in incremental graph.
 * @typedef {import('./recursive_types').ConstValue} ConstValue
 */

/**
 * Union type for values that can be stored in the database.
 * @typedef {ComputedValue | Freshness} DatabaseStoredValue
 */

/**
 * Capabilities needed for IncrementalGraph operations
 * @typedef {object} IncrementalGraphCapabilities
 * @property {RootDatabase} database - A root database instance
 */

/**
 * A computor function for node definitions.
 * Receives inputs, optional old value, and positional bindings array.
 * Bindings are matched to argument positions by position (not by variable name).
 * Each binding must be a ConstValue (JSON-serializable primitives, arrays, or records).
 * @typedef {(inputs: Array<ComputedValue>, oldValue: ComputedValue | undefined, bindings: Array<ConstValue>) => Promise<ComputedValue | Unchanged>} NodeDefComputor
 */

/**
 * Simpler computor without bindings parameter (used for concrete instantiated nodes).
 * @typedef {(inputs: Array<ComputedValue>, oldValue: ComputedValue | undefined) => Promise<ComputedValue | Unchanged>} ConcreteNodeComputor
 */

/**
 * An expression string pattern used in node definitions.
 * @typedef {import('./database/types').SchemaPattern} SchemaPattern
 */

/**
 * A serialized node key string for storage.
 * @typedef {import('./database/types').NodeKeyString} NodeKeyString
 */

/**
 * The head/functor part of SchemaPattern.
 * @typedef {import('./database/types').NodeName} NodeName
 */

/**
 * A schema hash string identifying an incremental graph schema.
 * @typedef {import('./database/types').SchemaHash} SchemaHash
 */

/**
 * A concrete node definition with resolved inputs and output.
 * Used for runtime instantiations of pattern nodes.
 * @typedef {object} ConcreteNode
 * @property {NodeKeyString} output - Serialized concrete output key
 * @property {Array<NodeKeyString>} inputs - Array of serialized concrete input keys
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
 * @property {ComputedValue} value - The computed or cached value
 * @property {RecomputeStatus} status - Status of the operation
 */

/**
 * Extended freshness status including missing state.
 * @typedef {'up-to-date' | 'potentially-outdated' | 'missing'} FreshnessStatus
 */

/**
 * Unified node definition.
 *
 * Note:
 * This does not use nominal types, ie SchemaPattern, because this is user input.
 * The output and inputs can be any strings, not necessarily valid patterns.
 *
 * @typedef {object} NodeDef
 * @property {string} output - Pattern or exact key (e.g., "event_context(e)" or 'status("active")')
 * @property {Array<string>} inputs - Pattern dependencies
 * @property {NodeDefComputor} computor - Function that computes the output from inputs, old value, and typed bindings
 * @property {boolean} isDeterministic - Whether the computor is deterministic (same inputs always produce same output)
 * @property {boolean} hasSideEffects - Whether the computor has side effects (performs actions beyond computing the return value)
 */

/**
 * @typedef {import('./expr').ParsedExpr} ParsedExpr
 */

/**
 * Compiled node with cached metaArray<data> for efficient matching and instantiation.
 * @typedef {object} CompiledNode
 * @property {NodeDef} source - The original node definition
 * @property {ParsedExpr} outputExpr - Parsed output expression
 * @property {SchemaPattern} canonicalOutput - Canonical form of output
 * @property {Array<ParsedExpr>} inputExprs - Parsed input expressions
 * @property {Array<SchemaPattern>} canonicalInputs - Canonical forms of inputs
 * @property {NodeName} head - Head/name of the output expression
 * @property {number} arity - Number of arguments in output
 * @property {boolean} isPattern - True if output contains variables (identifiers)
 * @property {Map<string, Array<number>>} repeatedVarPositions - Map from variable name to positions where it appears
 * @property {Set<string>} varsUsedInInputs - Variables used in any input pattern
 */

module.exports = {};
