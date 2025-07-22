const express = require('express');
const upload = require('../storage');
const { fromRequest, markDone } = require('../request_identifier');

/** @typedef {import('../random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('../filesystem/creator').FileCreator} Creator */
/** @typedef {import('../filesystem/checker').FileChecker} Checker */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {Creator} creator - A file system creator instance.
 * @property {Checker} checker - A file system checker instance.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 */

/**
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const uploadMiddleware = upload.makeUpload(capabilities);
    const router = express.Router();
    router.post('/upload', uploadMiddleware.array('files'), async (req, res) => {
        let reqId;
        try {
            reqId = fromRequest(req);
        } catch {
            capabilities.logger.logError(
                {
                    error: 'Missing request identifier',
                    path: req.path,
                    query: req.query,
                    headers: req.headers,
                },
                'Upload failed - invalid request identifier'
            );
            return res.status(400).json({
                success: false,
                error: 'Missing request_identifier parameter',
            });
        }

        const files = Array.isArray(req.files) ? req.files : [];
        const uploaded = files.map((f) => f.filename);
        capabilities.logger.logInfo(
            { files: uploaded, request_identifier: reqId.identifier },
            'Files uploaded'
        );
        await markDone(capabilities, reqId);
        return res.json({ success: true, files: uploaded });
    });
    return router;
}

module.exports = { makeRouter };
