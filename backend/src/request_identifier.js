const path = require("path");
const randomModule = require("./random");

/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('./filesystem/creator').FileCreator} Creator */
/** @typedef {import('./filesystem/checker').FileChecker} Checker */
/** @typedef {import('./environment').Environment} Environment */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {Creator} creator - A file system creator instance.
 * @property {Checker} checker - A file system checker instance.
 * @property {Environment} environment - An environment instance.
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
        this.identifier = identifier;
        if (this.__brand !== undefined) {
            throw new Error();
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
    /** @type {any} */
    const query = req.query;
    const reqId = query['request_identifier'];
    if (reqId === null || reqId === undefined || String(reqId).trim() === '') {
        throw new Error("Missing request_identifier field");
    }
    return new RequestIdentifierClass(String(reqId));
}

/**
 * Creates a random request identifier.
 * @param {Capabilities} capabilities
 * @returns {RequestIdentifier}
 */
function random(capabilities) {
    const reqId = randomModule.string(capabilities, 8);
    return new RequestIdentifierClass(reqId.toString());
}

/**
 * @param {Capabilities} capabilities
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
 * @param {Capabilities} capabilities
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
 * @param {Capabilities} capabilities
 * @param {RequestIdentifier} reqId
 * @returns {Promise<string>} - path to the target directory.
 */
async function makeDirectory(capabilities, reqId) {
    const uploadDir = capabilities.environment.workingDirectory();
    const ret = path.join(uploadDir, reqId.identifier);
    await capabilities.creator.createDirectory(ret);
    return ret;
}

module.exports = {
    fromRequest,
    random,
    markDone,
    isDone,
    makeDirectory,
};
