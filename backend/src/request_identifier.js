const path = require("path");
const fs = require("fs");
const randomModule = require("./random");
const { resultsDirectory } = require("./environment");

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
    if (reqId === null || reqId === undefined) {
        throw new Error("Missing request_identifier field");
    }
    return new RequestIdentifierClass(reqId.toString());
}

/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 */

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
 * @param {RequestIdentifier} reqId
 * @returns {Promise<void>}
 */
async function markDone(reqId) {
    const uploadDir = resultsDirectory();
    await fs.promises.mkdir(uploadDir, { recursive: true });
    // e.g. /var/www/uploads/REQ12345.done
    const target = path.join(uploadDir, reqId.identifier + ".done");
    await fs.promises.writeFile(target, "", "utf8");
}

/**
 * @param {RequestIdentifier} reqId
 * @returns {Promise<boolean>}
 */
async function isDone(reqId) {
    const uploadDir = resultsDirectory();
    const target = path.join(uploadDir, reqId.identifier + ".done");
    return fs.existsSync(target);
}

/**
 * @param {RequestIdentifier} reqId
 * @returns {Promise<string>} - path to the target directory.
 */
async function makeDirectory(reqId) {
    const uploadDir = resultsDirectory();
    const ret = path.join(uploadDir, reqId.identifier);
    await fs.promises.mkdir(ret, { recursive: true });
    return ret;
}

module.exports = {
    fromRequest,
    random,
    markDone,
    isDone,
    makeDirectory,
};
