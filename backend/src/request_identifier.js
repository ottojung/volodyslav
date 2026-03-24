const randomModule = require("./random");

/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */

/**
 * Minimal capabilities needed for generating random identifiers
 * @typedef {object} RandomCapabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance
 */

/**
 * Error thrown when a request identifier is missing from the request.
 */
class MissingRequestIdentifierError extends Error {
    constructor() {
        super("Missing request_identifier field");
        this.name = "MissingRequestIdentifierError";
    }
}

/**
 * Type guard for MissingRequestIdentifierError.
 * @param {unknown} object
 * @returns {object is MissingRequestIdentifierError}
 */
function isMissingRequestIdentifierError(object) {
    return object instanceof MissingRequestIdentifierError;
}

/**
 * Error thrown when a request identifier is invalid.
 */
class InvalidRequestIdentifierError extends Error {
    /**
     * @param {string} identifier
     */
    constructor(identifier) {
        super("Request identifier must be a non-empty string");
        this.name = "InvalidRequestIdentifierError";
        this.identifier = identifier;
    }
}

/**
 * Type guard for InvalidRequestIdentifierError.
 * @param {unknown} object
 * @returns {object is InvalidRequestIdentifierError}
 */
function isInvalidRequestIdentifierError(object) {
    return object instanceof InvalidRequestIdentifierError;
}

class RequestIdentifierClass {
    /** @type {string} */
    identifier;

    /**
     * This is a value that is never actually assigned.
     * Its purpose is to make `RequestIdentifier` a nominal type.
     * @private
     * @type {undefined}
     */
    __brand;

    /**
     * @param {string} identifier
     */
    constructor(identifier) {
        if (typeof identifier !== 'string' || identifier.trim() === '') {
            throw new InvalidRequestIdentifierError(String(identifier));
        }
        this.identifier = identifier;
        if (this.__brand !== undefined) {
            throw new InvalidRequestIdentifierError(String(identifier));
        }
    }
}

/** @typedef {RequestIdentifierClass} RequestIdentifier */

/**
 * Primary constructor for a requestIdentifier.
 * @param {import('express').Request} req
 * @returns {RequestIdentifier}
 */
function fromRequest(req) {
    const query = req.query || {};
    const reqId = query['request_identifier'];
    const reqIdStr = String(reqId).trim();
    if (reqId === null || reqId === undefined || reqIdStr === '') {
        throw new MissingRequestIdentifierError();
    }
    return new RequestIdentifierClass(reqIdStr);
}

/**
 * Creates a random request identifier.
 * @param {RandomCapabilities} capabilities
 * @returns {RequestIdentifier}
 */
function random(capabilities) {
    const reqId = randomModule.string(capabilities, 8);
    return new RequestIdentifierClass(reqId.toString());
}

module.exports = {
    fromRequest,
    random,
    isMissingRequestIdentifierError,
    isInvalidRequestIdentifierError,
};
