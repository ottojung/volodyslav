const { IdentifierLookupConflictError } = require('./replica_errors');

const { nodeIdentifierToString } = require('./types');

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
 * The inputs sublevel is the materialized-node registry.
 * @param {SchemaStorage} targetStorage
 * @param {IdentifierLookup} finalLookup
 * @returns {Promise<void>}
 */
async function assertValidFinalMergeState(targetStorage, finalLookup) {
    const knownIdentifiers = new Set(finalLookup.idToKey.keys());
    const materializedIdentifiers = new Set();
    for await (const identifier of targetStorage.inputs.keys()) {
        const identifierString = nodeIdentifierToString(identifier);
        materializedIdentifiers.add(identifierString);
        if (!knownIdentifiers.has(identifierString)) {
            throw new FinalMergeStateError(`stored node ${identifierString} has no lookup entry`);
        }
        const inputs = await targetStorage.inputs.get(identifier);
        const inputIds = Array.isArray(inputs) ? inputs : [];
        for (const input of inputIds) {
            if (!knownIdentifiers.has(nodeIdentifierToString(input))) {
                throw new FinalMergeStateError(
                    `node ${identifierString} references unknown input ${nodeIdentifierToString(input)}`
                );
            }
        }
    }
    for (const identifierString of knownIdentifiers) {
        if (!materializedIdentifiers.has(identifierString)) {
            throw new FinalMergeStateError(
                `lookup identifier ${identifierString} has no materialized node`
            );
        }
    }
    for (const sublevel of [
        targetStorage.values,
        targetStorage.freshness,
        targetStorage.counters,
        targetStorage.timestamps,
    ]) {
        for await (const identifier of sublevel.keys()) {
            if (!knownIdentifiers.has(nodeIdentifierToString(identifier))) {
                throw new FinalMergeStateError(
                    `discarded identifier ${nodeIdentifierToString(identifier)} remains in storage`
                );
            }
        }
    }
    for await (const identifier of targetStorage.valid.keys()) {
        const identifierString = nodeIdentifierToString(identifier);
        if (!knownIdentifiers.has(identifierString)) {
            throw new FinalMergeStateError(
                `valid references discarded identifier ${identifierString}`
            );
        }
        const validDependents = await targetStorage.valid.get(identifier) ?? [];
        for (const dependent of validDependents) {
            const dependentString = nodeIdentifierToString(dependent);
            if (!knownIdentifiers.has(dependentString)) {
                throw new FinalMergeStateError(
                    `valid[${identifierString}] references unknown identifier ${dependentString}`
                );
            }
            const dependentStored = await targetStorage.inputs.get(dependent);
            const dependentInputs = Array.isArray(dependentStored) ? dependentStored : [];
            if (!dependentInputs.some(input => nodeIdentifierToString(input) === identifierString)) {
                throw new FinalMergeStateError(
                    `valid[${identifierString}] is incompatible with inputs[${dependentString}]`
                );
            }
        }
    }
    for await (const identifier of targetStorage.inputs.keys()) {
        if (await targetStorage.freshness.get(identifier) !== 'up-to-date') {
            continue;
        }
        const identifierString = nodeIdentifierToString(identifier);
        const storedInputs = await targetStorage.inputs.get(identifier);
        for (const input of Array.isArray(storedInputs) ? storedInputs : []) {
            const validDependents = await targetStorage.valid.get(input) ?? [];
            if (!validDependents.some(dependent => nodeIdentifierToString(dependent) === identifierString)) {
                throw new FinalMergeStateError(
                    `up-to-date node ${identifierString} lacks validity for input ${nodeIdentifierToString(input)}`
                );
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
    for await (const id of storage.inputs.keys()) {
        if (!lookup.idToKey.has(nodeIdentifierToString(id))) {
            throw new IdentifierLookupConflictError(
                `${context}: materialized node ${nodeIdentifierToString(id)} has no identifiers_keys_map entry`
            );
        }
    }
}

module.exports = {
    assertValidFinalMergeState,
    assertLookupCoversMaterializedNodes,
    FinalMergeStateError,
    isFinalMergeStateError,
};
