const random = require("../../../random");

const NODE_IDENTIFIER_PATTERN = /^[a-z]{9}$/;

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

/** @typedef {NodeIdentifierClass} NodeIdentifier */

/**
 * @typedef {object} Capabilities
 * @property {import('../../../random/seed').NonDeterministicSeed} seed
 */

/**
 * @param {string} identifier
 * @returns {boolean}
 */
function isValidNodeIdentifier(identifier) {
    return NODE_IDENTIFIER_PATTERN.test(identifier);
}

/**
 * @param {Capabilities} capabilities
 * @returns {NodeIdentifier}
 */
function makeNodeIdentifier(capabilities) {
    return nodeIdentifierFromString(random.basicString(capabilities, 9));
}

/**
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
 * @param {NodeIdentifier} identifier
 * @returns {string}
 */
function nodeIdentifierToString(identifier) {
    return identifier.identifier;
}

/**
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
