const path = require('path');
const fs = require('fs');
const { uploadDir } = require('./config');

/**
 * Primary constructor for a requestIdentifier.
 * @param {import('express').Request} req
 * @returns {string}
 */
function fromRequest(req) {
    const reqId = req.query.request_identifier;
    if (!reqId) {
        throw new Error('Missing request_identifier field');
    }
    return String(reqId);
}

/**
 * @param {string} reqId
 * @returns {void}
 */
function markDone(reqId) {
    // e.g. /var/www/uploads/REQ12345.done
    const target = path.join(uploadDir, reqId + ".done");
    fs.writeFileSync(target, "", "utf8");
}

/**
 * @param {string} reqId
 * @returns {boolean}
 */
function isDone(reqId) {
    const target = path.join(uploadDir, reqId + ".done");
    return fs.existsSync(target);
}


module.exports = { fromRequest, markDone, isDone };
