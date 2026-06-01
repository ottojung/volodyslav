const { nodeIdentifierFromString, nodeIdentifierToString } = require('./node_identifier');
const {
    makeIdentifierLookup,
    nodeKeyToIdFromLookup,
} = require('./identifier_lookup');
const { MalformedIdentifierLookupError } = require('./replica_errors');

/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */

/**
 * Parse a persisted identifier lookup value from replica global metadata.
 * Missing metadata is treated as an empty lookup so legacy/unit-test fixtures
 * that write identifier-addressed nodes directly can still merge by identity.
 *
 * @param {unknown} rawEntries
 * @returns {IdentifierLookup}
 */
function parseIdentifierLookup(rawEntries) {
    if (rawEntries === undefined) throw new MalformedIdentifierLookupError(rawEntries);
    if (!Array.isArray(rawEntries)) throw new MalformedIdentifierLookupError(rawEntries);
    return makeIdentifierLookup(rawEntries);
}

/**
 * Build identifier translation tables from host identifiers into the target
 * replica's reconciled identifier namespace.
 *
 * The host and target may independently allocate different identifiers for the
 * same semantic node key. Decisions must be made in the target namespace, while
 * host data still has to be read from the original host namespace. These maps
 * keep that distinction explicit.
 *
 * @param {IdentifierLookup} hostLookup
 * @param {IdentifierLookup} reconciledHostLookup
 * @returns {{ hostToTarget: Map<string, NodeIdentifier>, targetToHost: Map<string, NodeIdentifier> }}
 */
function makeHostIdentifierTranslation(hostLookup, reconciledHostLookup) {
    /** @type {Map<string, NodeIdentifier>} */
    const hostToTarget = new Map();
    /** @type {Map<string, NodeIdentifier>} */
    const targetToHost = new Map();

    for (const [hostIdentifierString, nodeKey] of hostLookup.idToKey.entries()) {
        const hostIdentifier = nodeIdentifierFromString(hostIdentifierString);
        const targetIdentifier = nodeKeyToIdFromLookup(reconciledHostLookup, nodeKey);
        if (targetIdentifier !== undefined) {
            hostToTarget.set(hostIdentifierString, targetIdentifier);
            targetToHost.set(nodeIdentifierToString(targetIdentifier), hostIdentifier);
        }
    }

    return { hostToTarget, targetToHost };
}

module.exports = {
    makeHostIdentifierTranslation,
    parseIdentifierLookup,
};
