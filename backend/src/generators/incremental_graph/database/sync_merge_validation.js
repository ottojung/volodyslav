const { nodeIdentifierToString } = require('./types');
const { nodeIdentifierFromString, compareNodeIdentifier } = require('./node_identifier');
const { GRAPH_SCHEME_KEY, parseGraphScheme, deriveInputEdges, GraphSchemeError } = require('./graph_scheme');
const { fromISOString } = require('../../../datetime');
const { validateValueClock } = require('./value_clock');

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
 * @param {unknown} value
 * @returns {boolean}
 */
function isParseableIsoTimestamp(value) {
    return typeof value === 'string' && fromISOString(value).isValid;
}

/**
 * @param {unknown} record
 * @returns {boolean}
 */
function isValidTimestampRecord(record) {
    return record !== null
        && typeof record === 'object'
        && isParseableIsoTimestamp(Reflect.get(record, 'createdAt'))
        && isParseableIsoTimestamp(Reflect.get(record, 'modifiedAt'));
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
        const valueClock = await storage.valueClocks.get(identifier);
        if (valueClock === undefined) {
            throw new ReplicaStateInvariantError(context, 'has no value clock', identifierString);
        }
        validateValueClock(valueClock);
    }

    for (const identifierString of cachedIdentifiers) {
        if (!materializedIdentifiers.has(identifierString)) {
            throw new ReplicaStateInvariantError(context, 'has cached value but no identifier lookup entry', identifierString);
        }
    }
    for await (const identifier of storage.freshness.keys()) {
        const identifierString = nodeIdentifierToString(identifier);
        if (!materializedIdentifiers.has(identifierString)) {
            throw new ReplicaStateInvariantError(context, 'has freshness entry but no identifier lookup entry', identifierString);
        }
    }
    for await (const identifier of storage.timestamps.keys()) {
        const identifierString = nodeIdentifierToString(identifier);
        if (!materializedIdentifiers.has(identifierString)) {
            throw new ReplicaStateInvariantError(context, 'has timestamps but no identifier lookup entry', identifierString);
        }
    }
    for await (const identifier of storage.valueClocks.keys()) {
        const identifierString = nodeIdentifierToString(identifier);
        if (!materializedIdentifiers.has(identifierString)) {
            throw new ReplicaStateInvariantError(context, 'has value clock but no identifier lookup entry', identifierString);
        }
        const valueClock = await storage.valueClocks.get(identifier);
        validateValueClock(valueClock);
    }
    for await (const nodeKey of storage.conflictFrontiers.keys()) {
        if (lookup.keyToId.has(String(nodeKey))) {
            throw new ReplicaStateInvariantError(context, 'has both materialization and conflict frontier', String(nodeKey));
        }
        const frontier = await storage.conflictFrontiers.get(nodeKey);
        validateValueClock(frontier);
    }

    /** @type {Map<string, import('./types').NodeIdentifier[]>} */
    const inputEdgesByIdentifier = new Map();
    for (const identifierString of materializedIdentifiers) {
        const identifier = nodeIdentifierFromString(identifierString);
        let inputs;
        try {
            inputs = deriveInputEdges(scheme, lookup, identifier);
        } catch (error) {
            if (error instanceof GraphSchemeError) {
                throw new ReplicaStateInvariantError(
                    context,
                    `depends on unmaterialized input (${error.message})`,
                    identifierString
                );
            }
            throw error;
        }
        for (const input of inputs) {
            const inputString = nodeIdentifierToString(input);
            if (!materializedIdentifiers.has(inputString)) {
                throw new ReplicaStateInvariantError(context, `depends on unmaterialized input ${inputString}`, identifierString);
            }
        }
        inputEdgesByIdentifier.set(identifierString, inputs);
    }

    for await (const identifier of storage.valid.keys()) {
        const identifierString = nodeIdentifierToString(identifier);
        if (!materializedIdentifiers.has(identifierString)) {
            throw new ReplicaStateInvariantError(context, 'valid key is not materialized', identifierString);
        }
        const validDependents = await storage.valid.get(identifier) ?? [];
        // The validity array must be strictly increasing (sorted, no duplicates).
        let previous = null;
        for (const dependent of validDependents) {
            if (previous !== null && compareNodeIdentifier(previous, dependent) >= 0) {
                const depStr = nodeIdentifierToString(dependent);
                throw new ReplicaStateInvariantError(
                    context,
                    `valid set is not strictly sorted and unique (noncanonical at ${depStr})`,
                    identifierString
                );
            }
            previous = dependent;
        }
        for (const dependent of validDependents) {
            const dependentString = nodeIdentifierToString(dependent);
            if (!materializedIdentifiers.has(dependentString)) {
                throw new ReplicaStateInvariantError(context, `valid value references unmaterialized dependent ${dependentString}`, identifierString);
            }
            const dependentInputs = inputEdgesByIdentifier.get(dependentString) ?? [];
            if (!dependentInputs.some(input => nodeIdentifierToString(input) === identifierString)) {
                throw new ReplicaStateInvariantError(context, `valid value is not compatible with dependent ${dependentString}`, identifierString);
            }
        }
    }

    for (const identifierString of materializedIdentifiers) {
        const identifier = nodeIdentifierFromString(identifierString);
        const freshness = await storage.freshness.get(identifier);
        if (freshness !== 'up-to-date') continue;
        const derivedEdges = inputEdgesByIdentifier.get(identifierString) ?? [];
        for (const input of derivedEdges) {
            const inputString = nodeIdentifierToString(input);
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


module.exports = {
    assertValidFinalMergeState,
    assertValidReplicaMaterializationState,
    ReplicaStateInvariantError,
    FinalMergeStateError,
    isFinalMergeStateError,
    isReplicaStateInvariantError,
};
