const random = require("../../../random");
const {
    nodeIdentifierToString: nodeIdentifierToRawString,
    stringToNodeIdentifier,
} = require("./types");

/**
 * Persisted node identifiers are exactly 9 lowercase ASCII letters.
 * They are safe to embed in database keys and filesystem path segments
 * without any additional escaping layer.
 */
const NODE_IDENTIFIER_PATTERN = /^[a-z]{9}$/;

/**
 * Thrown when code attempts to construct or parse an invalid identifier string.
 */
class InvalidNodeIdentifierError extends Error {
    /**
     * @param {string} identifier
     */
    constructor(identifier) {
        super(`Invalid node identifier: ${identifier}`);
        this.name = "InvalidNodeIdentifierError";
        this.identifier = identifier;
    }
}

/**
 * @param {unknown} object
 * @returns {object is InvalidNodeIdentifierError}
 */
function isInvalidNodeIdentifierError(object) {
    return object instanceof InvalidNodeIdentifierError;
}

/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').DatabaseKey} DatabaseKey */

/**
 * @typedef {object} Capabilities
 * @property {import('../../../random/seed').NonDeterministicSeed} seed
 */

/**
 * Check whether a plain string already satisfies the NodeIdentifier format.
 * @param {string} identifier
 * @returns {boolean}
 */
function isValidNodeIdentifier(identifier) {
    return NODE_IDENTIFIER_PATTERN.test(identifier);
}

/**
 * Allocate a new random identifier using the shared random capability.
 * @param {Capabilities} capabilities
 * @returns {NodeIdentifier}
 */
function makeNodeIdentifier(capabilities) {
    return nodeIdentifierFromString(random.basicString(capabilities, 9));
}

/**
 * Parse and validate a persisted identifier string.
 * @param {string} identifier
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
    InvalidNodeIdentifierError,
    isInvalidNodeIdentifierError,
    isValidNodeIdentifier,
    makeNodeIdentifier,
    nodeIdentifierToDatabaseKey,
    nodeIdentifierFromString,
    nodeIdentifierToString,
};
