/**
 * The supported persisted-identifier domain of a migration source replica.
 *
 * `incremental-graph-journal-types.md` §Persisted identifier form across the
 * bootstrap and migration boundary states that domain over the persisted forms of
 * every supported source era, and its fail-closed clause applies to this boundary
 * exactly as it applies to the canonical-bootstrap boundary: a replica which
 * persists an identifier outside the domain is not a supported source, so the
 * transition rejects the replica instead of emitting a target which materializes
 * nodes no Journal record can name.
 *
 * A migration transports every identifier of its source replica into the target
 * unchanged, so this is the one point at which the transported set is known and
 * can be asked whether it is supported. The check runs while the source lookup is
 * read, before the migration callback runs and before the target replica is
 * written, so an unsupported source leaves no target state behind.
 *
 * This module re-derives nothing and repairs nothing. A transported identifier
 * carries the uniqueness argument of the era that minted it, so re-minting,
 * re-spelling or normalizing one would replace that argument with one this project
 * cannot make, and would change which physical identity a materialized node has.
 *
 * This module is pure. It performs no I/O and consults no clock: everything it
 * reports about a source is what the source persisted.
 */

const { makeUnsupportedPersistedIdentifierError } = require("./migration_errors");
const { isNodeIdentifier } = require("./journal");

/** @typedef {ReturnType<typeof makeUnsupportedPersistedIdentifierError>} UnsupportedPersistedIdentifier */
/** @typedef {import('./database/identifier_lookup').IdentifierLookup} IdentifierLookup */

/**
 * Report that a migration source replica persists an identifier outside the
 * supported domain, which makes it an unsupported migration source.
 *
 * @param {IdentifierLookup} lookup - The lookup the source replica persists.
 * @param {string} context - How the migration names the replica it read.
 * @returns {UnsupportedPersistedIdentifier | undefined} The error, or `undefined`
 *   when every persisted identifier is inside the domain.
 */
function tryUnsupportedPersistedIdentifier(lookup, context) {
    for (const identifierString of lookup.idToKey.keys()) {
        if (isNodeIdentifier(identifierString)) continue;
        return makeUnsupportedPersistedIdentifierError(context, identifierString);
    }
    return undefined;
}

module.exports = {
    tryUnsupportedPersistedIdentifier,
};