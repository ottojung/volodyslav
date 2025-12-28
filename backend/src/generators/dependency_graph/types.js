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

module.exports = {};
