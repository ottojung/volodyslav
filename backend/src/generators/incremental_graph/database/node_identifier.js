const {
    nodeIdentifierToString: nodeIdentifierToRawString,
    stringToNodeIdentifier,
} = require("./types");

/**
 * Node identifiers follow the format `<base36-index>-<fingerprint>`.
 * The index is a base36 integer, the fingerprint is a machine-local
 * stable string of at least 9 lowercase ASCII letters.
 *
 * All identifiers are generated internally by `makeNodeIdentifier()` and are
 * never parsed from user input.  Therefore there is no
 * runtime validation of identifier strings — the pattern defined here exists
 * only as a specification / documentation constraint.
 */
const NODE_IDENTIFIER_PATTERN = /^[0-9a-z]+-[a-z]{9,}$/;

/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').DatabaseKey} DatabaseKey */

/**
 * Check whether a plain string satisfies the documented NodeIdentifier format.
 * @param {string} identifier
 * @returns {boolean}
 */
function isValidNodeIdentifier(identifier) {
    return NODE_IDENTIFIER_PATTERN.test(identifier);
}

/**
 * Allocate a deterministic node identifier from a fingerprint and a local index.
 * @param {string} fingerprint - The machine-local database fingerprint.
 * @param {number} index - The local node allocation index.
 * @returns {NodeIdentifier}
 */
function makeNodeIdentifier(fingerprint, index) {
    return nodeIdentifierFromString(`${index.toString(36)}-${fingerprint}`);
}

/**
 * Convert a plain string to the NodeIdentifier nominal type.
 *
 * Does NOT validate the string — all identifiers in the system are generated
 * internally by `makeNodeIdentifier()` and are never parsed from external
 * input, so runtime validation would serve no purpose. The returned value is
 * simply the input string cast to the nominal type.
 *
 * @param {string} identifier - A string that is already known to be a valid identifier.
 * @returns {NodeIdentifier}
 */
function nodeIdentifierFromString(identifier) {
    return stringToNodeIdentifier(identifier);
}

/**
 * Convert a nominal identifier back to its persisted string form.
 * @param {NodeIdentifier} identifier
 * @returns {string}
 */
function nodeIdentifierToString(identifier) {
    return nodeIdentifierToRawString(identifier);
}

/**
 * Convert an identifier to the branded database-key type used by typed sublevels.
 * This hides the NodeKeyString storage-brand detail from identifier-native callers.
 * @param {NodeIdentifier} identifier
 * @returns {DatabaseKey}
 */
function nodeIdentifierToDatabaseKey(identifier) {
    return identifier;
}

/**
 * Convert a typed database key that is known to hold an identifier back into a NodeIdentifier.
 * @param {DatabaseKey} key
 * @returns {NodeIdentifier}
 */
function databaseKeyToNodeIdentifier(key) {
    return nodeIdentifierFromString(String(key));
}

/**
 * Compare identifiers lexicographically by their persisted string values.
 * @param {NodeIdentifier} a
 * @param {NodeIdentifier} b
 * @returns {number}
 */
function compareNodeIdentifier(a, b) {
    const stringA = nodeIdentifierToString(a);
    const stringB = nodeIdentifierToString(b);
    if (stringA < stringB) {
        return -1;
    }
    if (stringA > stringB) {
        return 1;
    }
    return 0;
}

module.exports = {
    compareNodeIdentifier,
    databaseKeyToNodeIdentifier,
    isValidNodeIdentifier,
    makeNodeIdentifier,
    nodeIdentifierToDatabaseKey,
    nodeIdentifierFromString,
    nodeIdentifierToString,
};
