/**
 * Type definitions for DependencyGraph.
 */

/** @typedef {import('../../event').Event} Event */
/** @typedef {import('../database/class').Database} Database */
/** @typedef {import('../database/types').DatabaseValue} DatabaseValue */
/** @typedef {import('../database/types').Freshness} Freshness */
/** @typedef {import('./unchanged').Unchanged} Unchanged */

/**
 * Capabilities needed for DependencyGraph operations
 * @typedef {object} DependencyGraphCapabilities
 * @property {Database} database - A database instance
 */

/**
 * A computor function that takes inputs and old value, and produces new value or Unchanged.
 * @typedef {(inputs: Array<DatabaseValue>, oldValue: DatabaseValue | undefined) => DatabaseValue | Unchanged} Computor
 */

/**
 * A node in the dependency graph.
 * @typedef {object} GraphNode
 * @property {string} output - The name of the output node
 * @property {Array<string>} inputs - Array of input node names
 * @property {Computor} computor - Function that computes the output from inputs and old value
 */

/**
 * A computor function for schemas that receives bindings for variables.
 * @typedef {(inputs: Array<DatabaseValue>, oldValue: DatabaseValue | undefined, bindings: Record<string, string>) => DatabaseValue | Unchanged} SchemaComputor
 */

/**
 * A schema definition for parameterized nodes.
 * Schemas allow variables in outputs and inputs, and are instantiated on demand.
 * @typedef {object} Schema
 * @property {string} output - The output pattern (e.g., "event_context(e)")
 * @property {Array<string>} inputs - Array of input patterns (e.g., ["all_events"] or ["photo(p)"])
 * @property {Array<string>} variables - Array of variable names used in the schema (e.g., ["e"] or ["e", "p"])
 * @property {SchemaComputor} computor - Function that computes the output from inputs, old value, and bindings
 */

/**
 * Input definition for nodes (what callers pass to makeDependencyGraph).
 * Can be either a concrete node or a parameterized schema.
 * Variables are automatically derived from the output expression during compilation.
 * @typedef {object} NodeDef
 * @property {string} output - Output pattern or concrete node name
 * @property {Array<string>} inputs - Array of input patterns or node names
 * @property {Computor | SchemaComputor} computor - Computor function (with or without bindings parameter)
 */

/**
 * Compiled internal representation of nodes.
 * Both pattern nodes and concrete nodes are stored as CompiledNode.
 * @typedef {object} CompiledNode
 * @property {string} outputCanonical - Canonical form of output
 * @property {Array<string>} inputsCanonical - Canonical form of inputs
 * @property {import('./expr').ParsedExpr} outputExpr - Parsed output expression
 * @property {string} head - The head/name of the output
 * @property {number} arity - Number of arguments in the output
 * @property {Set<string>} variables - Extracted variables from output pattern
 * @property {Computor | SchemaComputor} computor - Original computor function
 * @property {boolean} isPattern - True if output contains variables
 * @property {boolean} [needsInstantiationMarker] - True if this instantiated node needs marker persisted
 */

module.exports = {};
