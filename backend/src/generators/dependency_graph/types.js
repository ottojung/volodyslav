/**
 * Type definitions for DependencyGraph.
 */

/** @typedef {import('../../event').Event} Event */
/** @typedef {import('../database/class').Database} Database */
/** @typedef {import('../database/types').DatabaseValue} DatabaseValue */
/** @typedef {import('../database/types').Freshness} Freshness */
/** @typedef {import('./unchanged').Unchanged} Unchanged */
/** @typedef {import('./expr').ConstValue} ConstValue */

/**
 * Capabilities needed for DependencyGraph operations
 * @typedef {object} DependencyGraphCapabilities
 * @property {Database} database - A database instance
 */

/**
 * A node definition in the unified authoring format.
 * This replaces both GraphNode and Schema from the old implementation.
 * @typedef {object} NodeDef
 * @property {string} output - The output pattern or exact key
 * @property {Array<string>} inputs - Input patterns/dependencies
 * @property {(inputs: Array<DatabaseValue>, oldValue: DatabaseValue | undefined, bindings: Record<string, ConstValue>) => DatabaseValue | Unchanged} computor - Computation function with typed bindings
 */

module.exports = {};
