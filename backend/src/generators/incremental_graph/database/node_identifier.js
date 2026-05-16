const random = require("../../../random");

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

class NodeIdentifierClass {
    /** @type {string} */
    identifier;

    /**
     * @private
     * @type {undefined}
     */
    __brand;

    /**
     * @param {string} identifier
     */
    constructor(identifier) {
        this.identifier = identifier;
        if (this.__brand !== undefined) {
            throw new Error("NodeIdentifier is a nominal type and should not be instantiated directly");
        }
    }
}

/**
 * Opaque random identifier for a materialized incremental-graph node.
 * The string format is intentionally restricted to nine lowercase letters.
 * @typedef {NodeIdentifierClass} NodeIdentifier
 */

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
    if (!isValidNodeIdentifier(identifier)) {
        throw new InvalidNodeIdentifierError(identifier);
    }
    return new NodeIdentifierClass(identifier);
}

/**
 * Convert a nominal identifier back to its persisted string form.
 * @param {NodeIdentifier} identifier
 * @returns {string}
 */
function nodeIdentifierToString(identifier) {
    return identifier.identifier;
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
    InvalidNodeIdentifierError,
    isInvalidNodeIdentifierError,
    isValidNodeIdentifier,
    makeNodeIdentifier,
    nodeIdentifierFromString,
    nodeIdentifierToString,
};
