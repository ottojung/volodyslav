const path = require("path");
const randomModule = require("./random");

/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('./filesystem/creator').FileCreator} Creator */
/** @typedef {import('./filesystem/checker').FileChecker} Checker */
/** @typedef {import('./environment').Environment} Environment */

/**
 * Minimal capabilities needed for generating random identifiers
 * @typedef {object} RandomCapabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance
 */

/**
 * Minimal capabilities needed for marking requests as done
 * @typedef {object} MarkDoneCapabilities
 * @property {Creator} creator - A file system creator instance
 * @property {Environment} environment - An environment instance
 */

/**
 * Minimal capabilities needed for checking if request is done
 * @typedef {object} IsDoneCapabilities
 * @property {Checker} checker - A file system checker instance
 * @property {Environment} environment - An environment instance
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

/**
 * Minimal capabilities needed for creating request directories
 * @typedef {object} MakeDirectoryCapabilities
 * @property {Creator} creator - A file system creator instance
 * @property {Environment} environment - An environment instance
 */

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

/**
 * @param {MarkDoneCapabilities} capabilities
 * @param {RequestIdentifier} reqId
 * @returns {Promise<void>}
 */
async function markDone(capabilities, reqId) {
    const uploadDir = capabilities.environment.workingDirectory();
    await capabilities.creator.createDirectory(uploadDir);
    const target = path.join(uploadDir, reqId.identifier + ".done");
    await capabilities.creator.createFile(target);
}

/**
 * @param {IsDoneCapabilities} capabilities
 * @param {RequestIdentifier} reqId
 * @returns {Promise<boolean>}
 */
async function isDone(capabilities, reqId) {
    const uploadDir = capabilities.environment.workingDirectory();
    const target = path.join(uploadDir, reqId.identifier + ".done");
    const proof = await capabilities.checker.fileExists(target);
    if (proof === null) {
        return false;
    } else {
        return true;
    }
}

/**
 * Creates a directory for the request identifier.
 * @param {MakeDirectoryCapabilities} capabilities
 * @param {RequestIdentifier} reqId
 * @returns {Promise<string>} The path to the created directory
 */
async function makeDirectory(capabilities, reqId) {
    const uploadDir = capabilities.environment.workingDirectory();
    const dirPath = path.join(uploadDir, reqId.identifier);
    await capabilities.creator.createDirectory(dirPath);
    return dirPath;
}

module.exports = {
    fromRequest,
    random,
    markDone,
    isDone,
    makeDirectory,
    MissingRequestIdentifierError,
    isMissingRequestIdentifierError,
    InvalidRequestIdentifierError,
    isInvalidRequestIdentifierError,
};
