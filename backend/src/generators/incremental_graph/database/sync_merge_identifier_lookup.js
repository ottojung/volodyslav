const {
    makeIdentifierLookup,
} = require('./identifier_lookup');
const { nodeKeyStringToString } = require('./types');
const {
    IdentifierLookupConflictError,
    MalformedIdentifierLookupError,
    MissingIdentifierLookupError,
} = require('./replica_errors');

/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */

/**
 * TODO: when we get a better opportunity, this module must grow
 * actual conflict resolution (e.g. last-writer-wins on identifier
 * assignment, or a user-visible conflict prompt).  Until then, failing
 * hard is the correct behaviour — it surfaces data corruption early
 * rather than silently producing an inconsistent lookup.
 */

/**
 * Parse a persisted identifier lookup value from replica global metadata.
 * A missing record is a hard error for identifier-native sync snapshots.
 *
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
 * Detect same-identifier/different-semantic-key conflicts between lookups.
 *
 * Same-semantic-key/different-identifier is NOT a conflict — it is a
 * normal merge scenario handled by the semantic-key-based planner.
 * Same-identifier/different-semantic-key IS corruption and remains hard.
 *
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @returns {void}
 * @throws {IdentifierLookupConflictError}
 */
function assertNoIdentifierLookupConflicts(targetLookup, hostLookup) {
    for (const [identifierString, targetNodeKey] of targetLookup.idToKey.entries()) {
        const hostNodeKey = hostLookup.idToKey.get(identifierString);
        if (hostNodeKey !== undefined && hostNodeKey !== targetNodeKey) {
            throw new IdentifierLookupConflictError(
                `Conflicting node key assignment for identifier ${identifierString}: `
                + `target=${nodeKeyStringToString(targetNodeKey)}, host=${nodeKeyStringToString(hostNodeKey)}. `
                + `Volodyslav will not resolve this automatically; manually fix the `
                + `identifiers_keys_map records before synchronizing again.`
            );
        }
    }
}

/**
 * Validate that the final lookup is a strict bijection: no duplicate semantic
 * keys and no duplicate identifiers.
 *
 * @param {IdentifierLookup} lookup
 * @param {string} context
 * @returns {void}
 * @throws {IdentifierLookupConflictError}
 */
function assertFinalLookupIsBisection(lookup, context) {
    if (lookup.keyToId.size !== lookup.idToKey.size) {
        throw new IdentifierLookupConflictError(
            `${context}: final lookup is not a bijection — `
            + `${lookup.keyToId.size} semantic keys vs ${lookup.idToKey.size} identifiers.`
        );
    }
}

module.exports = {
    assertNoIdentifierLookupConflicts,
    assertFinalLookupIsBisection,
    parseIdentifierLookup,
};
