const path = require("path");
const fs = require("fs");
const { uploadDir } = require("./config");
const randomModule = require("./random");

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
    }
}

/** @typedef {RequestIdentifierClass} RequestIdentifier */

/**
 * Primary constructor for a requestIdentifier.
 * @param {import('express').Request} req
 * @returns {RequestIdentifier}
 */
function fromRequest(req) {
    const reqId = req.query.request_identifier;
    if (reqId === null || reqId === undefined) {
        throw new Error("Missing request_identifier field");
    }
    return new RequestIdentifierClass(reqId.toString());
}


/**
 * Creates a random request identifier.
 * @param {import('./random').RNG} rng 
 * @returns {RequestIdentifier}
 */
function random(rng) {
    const reqId = randomModule.string(rng, 8);
    return new RequestIdentifierClass(reqId.toString());
}

/**
 * @param {RequestIdentifier} reqId
 * @returns {Promise<void>}
 */
async function markDone(reqId) {
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
    const target = path.join(uploadDir, reqId.identifier + ".done");
    return fs.existsSync(target);
}

/**
 * @param {RequestIdentifier} reqId
 * @returns {Promise<string>} - path to the target directory.
 */
async function makeDirectory(reqId) {
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
