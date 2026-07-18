const { nodeIdentifierToString } = require('./types');
const { nodeIdentifierFromString } = require('./node_identifier');
const { GRAPH_SCHEME_KEY, parseGraphScheme, deriveInputEdges } = require('./graph_scheme');

/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */

/**
 * Raised when a replica violates the materialized-cache invariant.
 */
class ReplicaStateInvariantError extends Error {
    /**
     * @param {string} context
     * @param {string} invariant
     * @param {string | undefined} identifier
     */
    constructor(context, invariant, identifier) {
        super(identifier === undefined ? `${context}: ${invariant}` : `${context}: identifier ${identifier} ${invariant}`);
        this.name = 'ReplicaStateInvariantError';
        this.context = context;
        this.invariant = invariant;
        this.identifier = identifier;
    }
}

class FinalMergeStateError extends ReplicaStateInvariantError {
    /** @param {string} detail */
    constructor(detail) {
        super('final sync merge state', detail, undefined);
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
 * @param {unknown} object
 * @returns {object is ReplicaStateInvariantError}
 */
function isReplicaStateInvariantError(object) {
    return object instanceof ReplicaStateInvariantError;
}

/**
 * @param {SchemaStorage} storage
 * @returns {Promise<Set<string>>}
 */
async function collectValueIdentifiers(storage) {
    const identifiers = new Set();
    for await (const identifier of storage.values.keys()) {
        identifiers.add(nodeIdentifierToString(identifier));
    }
    return identifiers;
}

/**
 * @param {unknown} record
 * @returns {boolean}
 */
function isValidTimestampRecord(record) {
    return record !== null
        && typeof record === 'object'
        && typeof Reflect.get(record, 'createdAt') === 'string'
        && typeof Reflect.get(record, 'modifiedAt') === 'string';
}

/**
 * Validate one replica's materialized-cache invariant and validity proofs.
 * @param {SchemaStorage} storage
 * @param {IdentifierLookup} lookup
 * @param {string} context
 * @returns {Promise<void>}
 */
async function assertValidReplicaMaterializationState(storage, lookup, context) {
    const scheme = parseGraphScheme(await storage.global.get(GRAPH_SCHEME_KEY));
    const materializedIdentifiers = new Set(lookup.idToKey.keys());
    const cachedIdentifiers = await collectValueIdentifiers(storage);

    for (const identifierString of materializedIdentifiers) {
        const identifier = nodeIdentifierFromString(identifierString);
        if (!cachedIdentifiers.has(identifierString)) {
            throw new ReplicaStateInvariantError(context, 'has no cached value', identifierString);
        }
        const freshness = await storage.freshness.get(identifier);
        if (freshness === undefined) {
            throw new ReplicaStateInvariantError(context, 'has no freshness entry', identifierString);
        }
        if (freshness !== 'up-to-date' && freshness !== 'potentially-outdated') {
            throw new ReplicaStateInvariantError(context, `has invalid freshness ${String(freshness)}`, identifierString);
        }
        const timestamps = await storage.timestamps.get(identifier);
        if (timestamps === undefined) {
            throw new ReplicaStateInvariantError(context, 'has no timestamps entry', identifierString);
        }
        if (!isValidTimestampRecord(timestamps)) {
            throw new ReplicaStateInvariantError(context, 'has structurally invalid timestamps', identifierString);
        }
    }

    for (const identifierString of cachedIdentifiers) {
        if (!materializedIdentifiers.has(identifierString)) {
            throw new ReplicaStateInvariantError(context, 'has cached value but no identifier lookup entry', identifierString);
        }
    }
    for await (const identifier of storage.freshness.keys()) {
        const identifierString = nodeIdentifierToString(identifier);
        if (!cachedIdentifiers.has(identifierString)) {
            throw new ReplicaStateInvariantError(context, 'has freshness entry but no cached value', identifierString);
        }
    }
    for await (const identifier of storage.timestamps.keys()) {
        const identifierString = nodeIdentifierToString(identifier);
        if (!cachedIdentifiers.has(identifierString)) {
            throw new ReplicaStateInvariantError(context, 'has timestamps but no cached value', identifierString);
        }
    }

    for await (const identifier of storage.valid.keys()) {
        const identifierString = nodeIdentifierToString(identifier);
        if (!cachedIdentifiers.has(identifierString)) {
            throw new ReplicaStateInvariantError(context, 'valid key is not materialized', identifierString);
        }
        const validDependents = await storage.valid.get(identifier) ?? [];
        for (const dependent of validDependents) {
            const dependentString = nodeIdentifierToString(dependent);
            if (!cachedIdentifiers.has(dependentString)) {
                throw new ReplicaStateInvariantError(context, `valid value references unmaterialized dependent ${dependentString}`, identifierString);
            }
            const derivedEdges = deriveInputEdges(scheme, lookup, dependent);
            if (!derivedEdges.some(edge => nodeIdentifierToString(edge) === identifierString)) {
                throw new ReplicaStateInvariantError(context, `valid value is not compatible with dependent ${dependentString}`, identifierString);
            }
        }
    }

    for (const identifierString of materializedIdentifiers) {
        const identifier = nodeIdentifierFromString(identifierString);
        if (await storage.freshness.get(identifier) !== 'up-to-date') continue;
        const derivedEdges = deriveInputEdges(scheme, lookup, identifier);
        for (const input of derivedEdges) {
            const inputString = nodeIdentifierToString(input);
            if (!materializedIdentifiers.has(inputString)) {
                throw new ReplicaStateInvariantError(context, `is up-to-date but depends on unmaterialized input ${inputString}`, identifierString);
            }
            const inputFreshness = await storage.freshness.get(input);
            if (inputFreshness !== 'up-to-date') {
                throw new ReplicaStateInvariantError(context, `is up-to-date but depends on non-up-to-date input ${inputString}`, identifierString);
            }
            const validDependents = await storage.valid.get(input) ?? [];
            if (!validDependents.some(dependent => nodeIdentifierToString(dependent) === identifierString)) {
                throw new ReplicaStateInvariantError(context, `is up-to-date but lacks validity for input ${inputString}`, identifierString);
            }
        }
    }
}

/**
 * Validate the identifier-keyed final state before making the replica active.
 * @param {SchemaStorage} targetStorage
 * @param {IdentifierLookup} finalLookup
 * @returns {Promise<void>}
 */
async function assertValidFinalMergeState(targetStorage, finalLookup) {
    try {
        await assertValidReplicaMaterializationState(targetStorage, finalLookup, 'final sync merge state');
    } catch (error) {
        if (isReplicaStateInvariantError(error)) {
            throw new FinalMergeStateError(error.identifier === undefined
                ? error.invariant
                : `identifier ${error.identifier} ${error.invariant}`);
        }
        throw error;
    }
}

/**
 * @param {SchemaStorage} storage
 * @param {IdentifierLookup} lookup
 * @param {string} context
 * @returns {Promise<void>}
 */
async function assertLookupCoversMaterializedNodes(storage, lookup, context) {
    await assertValidReplicaMaterializationState(storage, lookup, context);
}

/**
 * @param {SchemaStorage} storage
 * @param {IdentifierLookup} lookup
 * @param {string} context
 * @returns {Promise<void>}
 */
async function assertMaterializedNodesHaveTimestamps(storage, lookup, context) {
    await assertValidReplicaMaterializationState(storage, lookup, context);
}

module.exports = {
    assertValidFinalMergeState,
    assertValidReplicaMaterializationState,
    assertLookupCoversMaterializedNodes,
    assertMaterializedNodesHaveTimestamps,
    ReplicaStateInvariantError,
    FinalMergeStateError,
    isFinalMergeStateError,
    isReplicaStateInvariantError,
};
