const { makeIdentifierLookup } = require('./identifier_lookup');
const {
    IdentifierLookupConflictError,
    MalformedIdentifierLookupError,
    MissingIdentifierLookupError,
} = require('./replica_errors');

/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */

/**
 * Parse a persisted identifier lookup value from replica global metadata.
 * @param {unknown} rawEntries
 * @param {string} context
 * @returns {IdentifierLookup}
 */
function parseIdentifierLookup(rawEntries, context) {
    if (rawEntries === undefined) throw new MissingIdentifierLookupError(context);
    if (!Array.isArray(rawEntries)) throw new MalformedIdentifierLookupError(rawEntries);
    return makeIdentifierLookup(rawEntries);
}

/**
 * Reject the irreconcilable case where one storage identity names different
 * semantic nodes. Same-key/different-identifier assignments are normal merge input.
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @returns {void}
 */
function assertNoIdentifierCollisions(targetLookup, hostLookup) {
    for (const [identifierString, targetNodeKey] of targetLookup.idToKey.entries()) {
        const hostNodeKey = hostLookup.idToKey.get(identifierString);
        if (hostNodeKey !== undefined && hostNodeKey !== targetNodeKey) {
            throw new IdentifierLookupConflictError(
                `Conflicting node key assignment for identifier ${identifierString}: ` +
                `target maps it to ${String(targetNodeKey)}, host maps it to ${String(hostNodeKey)}. ` +
                `Volodyslav will not resolve this automatically; manually fix the identifiers_keys_map records before synchronizing again.`
            );
        }
    }
}

module.exports = { assertNoIdentifierCollisions, parseIdentifierLookup };
