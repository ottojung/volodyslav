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
 * Materialized nodes are identified by values.keys().
 * @param {SchemaStorage} targetStorage
 * @param {IdentifierLookup} finalLookup
 * @param {{ requireUpToDateTimestamps?: boolean }} [options]
 * @returns {Promise<void>}
 */
async function assertValidFinalMergeState(targetStorage, finalLookup, options = {}) {
    const requireUpToDateTimestamps = options.requireUpToDateTimestamps !== false;
    const scheme = parseGraphScheme(await targetStorage.global.get(GRAPH_SCHEME_KEY));
    const knownIdentifiers = new Set(finalLookup.idToKey.keys());
    const materializedIdentifiers = new Set();
    for await (const identifier of targetStorage.values.keys()) {
        const identifierString = nodeIdentifierToString(identifier);
        materializedIdentifiers.add(identifierString);
        if (!knownIdentifiers.has(identifierString)) {
            throw new FinalMergeStateError(`stored node ${identifierString} has no lookup entry`);
        }
    }
    for (const identifierString of knownIdentifiers) {
        const freshness = await targetStorage.freshness.get(nodeIdentifierFromString(identifierString));
        if (freshness === 'up-to-date' && !materializedIdentifiers.has(identifierString)) {
            throw new FinalMergeStateError(`up-to-date lookup identifier ${identifierString} has no materialized node`);
        }
        if (
            requireUpToDateTimestamps
            && freshness === 'up-to-date'
            && await targetStorage.timestamps.get(nodeIdentifierFromString(identifierString)) === undefined
        ) {
            throw new FinalMergeStateError(`up-to-date materialized node ${identifierString} has no timestamps entry`);
        }
    }
    for (const sublevel of [targetStorage.values, targetStorage.freshness, targetStorage.timestamps]) {
        for await (const identifier of sublevel.keys()) {
            if (!knownIdentifiers.has(nodeIdentifierToString(identifier))) {
                throw new FinalMergeStateError(`discarded identifier ${nodeIdentifierToString(identifier)} remains in storage`);
            }
        }
    }
    for await (const identifier of targetStorage.valid.keys()) {
        const identifierString = nodeIdentifierToString(identifier);
        if (!knownIdentifiers.has(identifierString) || !materializedIdentifiers.has(identifierString)) {
            throw new FinalMergeStateError(
                `valid key ${identifierString} is not a known materialized identifier`
            );
        }
        const validDependents = await targetStorage.valid.get(identifier) ?? [];
        for (const dependent of validDependents) {
            const dependentString = nodeIdentifierToString(dependent);
            if (!knownIdentifiers.has(dependentString) || !materializedIdentifiers.has(dependentString)) {
                throw new FinalMergeStateError(`valid[${identifierString}] references unknown identifier ${dependentString}`);
            }
            const derivedEdges = deriveInputEdges(scheme, finalLookup, dependent);
            if (!derivedEdges.some(edge => nodeIdentifierToString(edge) === identifierString)) {
                throw new FinalMergeStateError(`valid[${identifierString}] is not derived dependency of ${dependentString}`);
            }
        }
    }
    for await (const identifier of targetStorage.values.keys()) {
        if (await targetStorage.freshness.get(identifier) !== 'up-to-date') {
            continue;
        }
        const identifierString = nodeIdentifierToString(identifier);
        const derivedEdges = deriveInputEdges(scheme, finalLookup, identifier);
        for (const input of derivedEdges) {
            const inputString = nodeIdentifierToString(input);
            if (!knownIdentifiers.has(inputString) || !materializedIdentifiers.has(inputString)) {
                throw new FinalMergeStateError(
                    `up-to-date node ${identifierString} depends on non-materialized input ${inputString}`
                );
            }
            const inputFreshness = await targetStorage.freshness.get(input);
            if (inputFreshness !== 'up-to-date') {
                throw new FinalMergeStateError(
                    `up-to-date node ${identifierString} depends on stale input ${inputString}`
                );
            }
            const validDependents = await targetStorage.valid.get(input) ?? [];
            if (!validDependents.some(dependent => nodeIdentifierToString(dependent) === identifierString)) {
                throw new FinalMergeStateError(`up-to-date node ${identifierString} lacks validity for input ${inputString}`);
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
                `${context}: materialized node ${nodeIdentifierToString(id)} has no identifiers_keys_map entry`
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
                `${context}: materialized node ${nodeIdentifierToString(id)} has no timestamps entry`
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
