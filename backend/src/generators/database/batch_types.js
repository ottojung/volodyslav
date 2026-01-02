/**
 * Type-safe batch operation definitions for sublevel-based database operations.
 */

/** @typedef {import('./types').DatabaseValue} DatabaseValue */
/** @typedef {import('./types').Freshness} Freshness */

/**
 * A record storing the input dependencies of a node.
 * @typedef {object} InputsRecord
 * @property {string[]} inputs - Array of canonical input node names
 */

/**
 * Marker object for reverse dependency edges.
 * We only care about key existence, not the value.
 * @typedef {object} RevdepMarker
 * @property {true} __revdep - Marker to indicate this is a revdep edge
 */

/**
 * Type-safe batch operation for values sublevel.
 * @typedef {object} ValuesBatchOp
 * @property {'put' | 'del'} type - Operation type
 * @property {'values'} sublevel - Sublevel discriminator
 * @property {string} key - Canonical node name
 * @property {DatabaseValue} [value] - Required for 'put', omitted for 'del'
 */

/**
 * Type-safe batch operation for freshness sublevel.
 * @typedef {object} FreshnessBatchOp
 * @property {'put' | 'del'} type - Operation type
 * @property {'freshness'} sublevel - Sublevel discriminator
 * @property {string} key - Canonical node name
 * @property {Freshness} [value] - Required for 'put', omitted for 'del'
 */

/**
 * Type-safe batch operation for schema sublevels.
 * @typedef {object} SchemasBatchOp
 * @property {'put' | 'del'} type - Operation type
 * @property {'schemas'} sublevel - Sublevel discriminator
 * @property {string} schemaHash - Schema hash
 * @property {'inputs' | 'revdeps'} nestedSublevel - Either 'inputs' or 'revdeps'
 * @property {string} key - Key within the nested sublevel
 * @property {InputsRecord | RevdepMarker} [value] - InputsRecord for inputs, RevdepMarker for revdeps
 */

/**
 * Union of all type-safe batch operations.
 * @typedef {ValuesBatchOp | FreshnessBatchOp | SchemasBatchOp} GenericBatchOp
 */

module.exports = {};
