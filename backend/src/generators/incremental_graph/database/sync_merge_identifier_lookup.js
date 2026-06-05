const {
    makeIdentifierLookup,
} = require('./identifier_lookup');
const {
    IdentifierLookupConflictError,
    MalformedIdentifierLookupError,
    MissingIdentifierLookupError,
} = require('./replica_errors');

/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */

/**
 * Identifier-conflict policy for sync merges.
 *
 * Volodyslav assumes a single machine writes all snapshots.  In normal
 * single-origin usage the host and target use the same identifier for the
 * same semantic key, so conflicts cannot arise.  An identifier conflict
 * during merge means the persisted identifiers_keys_map records disagree
 * about which identifier maps to which key — something that should never
 * happen outside manual editing or a multi-origin scenario.
 *
 * Because Volodyslav is a personal tool (the client is the developer),
 * concurrency across multiple writers is deliberately excluded from this
 * code path.  A conflict is therefore treated as unrecoverable: the merge
 * fails hard and the user must manually repair the stored snapshots.
 *
 * TODO: If multi-origin sync is ever supported, this module must grow
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
 * Detect conflicts between host and target lookup snapshots.
 *
 * The module-level doc comment explains the rationale — single-origin
 * assumption makes conflicts unrecoverable by design.
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
                + `target=${String(targetIdentifier)}, host=${String(hostIdentifier)}. `
                + `Volodyslav will not resolve this automatically; manually fix the `
                + `identifiers_keys_map records before synchronizing again.`
            );
        }
    }

    for (const [identifierString, targetNodeKey] of targetLookup.idToKey.entries()) {
        const hostNodeKey = hostLookup.idToKey.get(identifierString);
        if (hostNodeKey !== undefined && hostNodeKey !== targetNodeKey) {
            throw new IdentifierLookupConflictError(
                `Conflicting node key assignment for identifier ${identifierString}: `
                + `target=${String(targetNodeKey)}, host=${String(hostNodeKey)}. `
                + `Volodyslav will not resolve this automatically; manually fix the `
                + `identifiers_keys_map records before synchronizing again.`
            );
        }
    }
}

module.exports = {
    assertNoIdentifierLookupConflicts,
    parseIdentifierLookup,
};
