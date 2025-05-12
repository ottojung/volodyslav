const path = require('path');
const fs = require('fs');
const { uploadDir } = require('./config');


/**
 * @class
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
     * @param {import('express').Request} req
     */
    constructor(req) {
        const reqId = req.query.request_identifier;
        if (reqId === null || reqId === undefined) {
            throw new Error('Missing request_identifier field');
        }
        this.identifier = String(reqId);
    }
}

/** @typedef {RequestIdentifierClass} RequestIdentifier */

/**
 * Primary constructor for a requestIdentifier.
 * @param {import('express').Request} req
 * @returns {RequestIdentifier}
 */
function fromRequest(req) {
    return new RequestIdentifierClass(req);
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
    markDone,
    isDone,
    makeDirectory,
};
