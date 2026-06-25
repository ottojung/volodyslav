const { IdentifierLookupConflictError } = require('./replica_errors');

const { nodeIdentifierToString } = require('./types');
const { nodeIdentifierFromString } = require('./node_identifier');
const { GRAPH_SCHEME_KEY, parseGraphScheme, deriveInputEdges } = require('./graph_scheme');

/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */

/**
 * Raised when a completed merge plan would persist identifier-keyed storage
 * that is not exactly covered by its final semantic lookup.
 */
class FinalMergeStateError extends Error {
    /** @param {string} detail */
    constructor(detail) {
        super(`Invalid final sync merge state: ${detail}`);
        this.name = 'FinalMergeStateError';
        this.detail = detail;
    }
}

/**
 * @param {unknown} object
 * @returns {object is FinalMergeStateError}
 */
function isFinalMergeStateError(object) {
    return object instanceof FinalMergeStateError;
}

/**
 * Validate the identifier-keyed final state before making the replica active.
 * Materialized nodes are identified by identifiers_keys_map. Cached nodes are
 * identified by values.keys().
 * @param {SchemaStorage} targetStorage
 * @param {IdentifierLookup} finalLookup
 * @param {{ requireUpToDateTimestamps?: boolean }} [options]
 * @returns {Promise<void>}
 */
async function assertValidFinalMergeState(targetStorage, finalLookup, options = {}) {
    void options;
    const scheme = parseGraphScheme(await targetStorage.global.get(GRAPH_SCHEME_KEY));
    const materializedIdentifiers = new Set(finalLookup.idToKey.keys());
    const cachedIdentifiers = new Set();

    for await (const identifier of targetStorage.values.keys()) {
        const identifierString = nodeIdentifierToString(identifier);
        cachedIdentifiers.add(identifierString);
        if (!materializedIdentifiers.has(identifierString)) {
            throw new FinalMergeStateError(`cached value ${identifierString} has no lookup entry`);
        }
    }

    for (const identifierString of materializedIdentifiers) {
        const identifier = nodeIdentifierFromString(identifierString);
        const freshness = await targetStorage.freshness.get(identifier);
        if (freshness === undefined) {
            throw new FinalMergeStateError(`materialized node ${identifierString} has no freshness entry`);
        }
        if (freshness !== 'missing' && freshness !== 'up-to-date' && freshness !== 'potentially-outdated') {
            throw new FinalMergeStateError(`materialized node ${identifierString} has invalid freshness ${String(freshness)}`);
        }
        if (await targetStorage.timestamps.get(identifier) === undefined) {
            throw new FinalMergeStateError(`materialized node ${identifierString} has no timestamps entry`);
        }
        const hasValue = cachedIdentifiers.has(identifierString);
        if (freshness === 'missing' && hasValue) {
            throw new FinalMergeStateError(`missing node ${identifierString} has a cached value`);
        }
        if (freshness !== 'missing' && !hasValue) {
            throw new FinalMergeStateError(`${freshness} node ${identifierString} has no cached value`);
        }
    }

    for await (const identifier of targetStorage.freshness.keys()) {
        if (!materializedIdentifiers.has(nodeIdentifierToString(identifier))) {
            throw new FinalMergeStateError(`freshness entry ${nodeIdentifierToString(identifier)} has no lookup entry`);
        }
    }
    for await (const identifier of targetStorage.timestamps.keys()) {
        if (!materializedIdentifiers.has(nodeIdentifierToString(identifier))) {
            throw new FinalMergeStateError(`timestamp entry ${nodeIdentifierToString(identifier)} has no lookup entry`);
        }
    }

    for await (const identifier of targetStorage.valid.keys()) {
        const identifierString = nodeIdentifierToString(identifier);
        if (!cachedIdentifiers.has(identifierString)) {
            throw new FinalMergeStateError(`valid key ${identifierString} is not a cached node`);
        }
        const validDependents = await targetStorage.valid.get(identifier) ?? [];
        for (const dependent of validDependents) {
            const dependentString = nodeIdentifierToString(dependent);
            if (!cachedIdentifiers.has(dependentString)) {
                throw new FinalMergeStateError(`valid[${identifierString}] references non-cached node ${dependentString}`);
            }
            const derivedEdges = deriveInputEdges(scheme, finalLookup, dependent);
            if (!derivedEdges.some(edge => nodeIdentifierToString(edge) === identifierString)) {
                throw new FinalMergeStateError(`valid[${identifierString}] is not derived dependency of ${dependentString}`);
            }
        }
    }
}

/**
 * Validate that every materialized node in storage has a corresponding entry
 * in the identifier lookup, and vice versa. Call this before building a merge
 * plan so corrupt snapshots are rejected before the planner can silently
 * ignore unreferenced materialized nodes.
 * @param {SchemaStorage} storage
 * @param {IdentifierLookup} lookup
 * @param {string} context
 * @returns {Promise<void>}
 */
async function assertLookupCoversMaterializedNodes(storage, lookup, context) {
    for await (const id of storage.values.keys()) {
        if (!lookup.idToKey.has(nodeIdentifierToString(id))) {
            throw new IdentifierLookupConflictError(
                `${context}: cached node ${nodeIdentifierToString(id)} has no identifiers_keys_map entry`
            );
        }
    }
    for await (const id of storage.freshness.keys()) {
        if (!lookup.idToKey.has(nodeIdentifierToString(id))) {
            throw new IdentifierLookupConflictError(
                `${context}: freshness entry ${nodeIdentifierToString(id)} has no identifiers_keys_map entry`
            );
        }
    }
    for await (const id of storage.timestamps.keys()) {
        if (!lookup.idToKey.has(nodeIdentifierToString(id))) {
            throw new IdentifierLookupConflictError(
                `${context}: timestamp entry ${nodeIdentifierToString(id)} has no identifiers_keys_map entry`
            );
        }
    }
}

/**
 * Validate that every materialized node covered by the identifier lookup has
 * timestamps before sync merge planning compares freshness across replicas.
 * @param {SchemaStorage} storage
 * @param {IdentifierLookup} lookup
 * @param {string} context
 * @returns {Promise<void>}
 */
async function assertMaterializedNodesHaveTimestamps(storage, lookup, context) {
    for await (const id of storage.values.keys()) {
        if (!lookup.idToKey.has(nodeIdentifierToString(id))) {
            continue;
        }
        const timestamps = await storage.timestamps.get(id);
        if (timestamps === undefined) {
            throw new IdentifierLookupConflictError(
                `${context}: cached node ${nodeIdentifierToString(id)} has no timestamps entry`
            );
        }
    }
}

module.exports = {
    assertValidFinalMergeState,
    assertLookupCoversMaterializedNodes,
    assertMaterializedNodesHaveTimestamps,
    FinalMergeStateError,
    isFinalMergeStateError,
};
