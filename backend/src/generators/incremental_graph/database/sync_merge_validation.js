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
        const identifierString = String(identifier);
        materializedIdentifiers.add(identifierString);
        if (!knownIdentifiers.has(identifierString)) {
            throw new FinalMergeStateError(`stored node ${identifierString} has no lookup entry`);
        }
        const inputs = await targetStorage.inputs.get(identifier);
        for (const input of inputs?.inputs ?? []) {
            if (!knownIdentifiers.has(String(input))) {
                throw new FinalMergeStateError(
                    `node ${identifierString} references unknown input ${String(input)}`
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
            if (!knownIdentifiers.has(String(identifier))) {
                throw new FinalMergeStateError(
                    `discarded identifier ${String(identifier)} remains in storage`
                );
            }
        }
    }
}

module.exports = {
    assertValidFinalMergeState,
    FinalMergeStateError,
    isFinalMergeStateError,
};
