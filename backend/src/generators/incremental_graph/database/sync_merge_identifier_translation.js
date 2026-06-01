const {
    makeIdentifierLookup,
} = require('./identifier_lookup');
const {
    IdentifierLookupConflictError,
    MalformedIdentifierLookupError,
} = require('./replica_errors');

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
 * Detect conflicts between host and target lookup snapshots.
 *
 * The merge path currently does not resolve cross-host identifier conflicts.
 * If the same semantic node key is mapped to different identifiers, we fail
 * fast with a readable error and leave resolution to a future policy.
 *
 * We also fail if the same identifier string maps to different semantic keys
 * between host and target.
 *
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @returns {void}
 * @throws {IdentifierLookupConflictError}
 */
function assertNoIdentifierLookupConflicts(targetLookup, hostLookup) {
    for (const [nodeKeyString, targetIdentifier] of targetLookup.keyToId.entries()) {
        const hostIdentifier = hostLookup.keyToId.get(nodeKeyString);
        if (hostIdentifier !== undefined && hostIdentifier !== targetIdentifier) {
            throw new IdentifierLookupConflictError(
                `Conflicting identifier assignment for node key ${nodeKeyString}: `
                + `target=${String(targetIdentifier)}, host=${String(hostIdentifier)}`
            );
        }
    }

    for (const [identifierString, targetNodeKey] of targetLookup.idToKey.entries()) {
        const hostNodeKey = hostLookup.idToKey.get(identifierString);
        if (hostNodeKey !== undefined && hostNodeKey !== targetNodeKey) {
            throw new IdentifierLookupConflictError(
                `Conflicting node key assignment for identifier ${identifierString}: `
                + `target=${String(targetNodeKey)}, host=${String(hostNodeKey)}`
            );
        }
    }
}

module.exports = {
    assertNoIdentifierLookupConflicts,
    parseIdentifierLookup,
};
