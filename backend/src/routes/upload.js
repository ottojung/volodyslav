const express = require('express');
const upload = require('../storage');
const { fromRequest } = require('../request_identifier');
const { isFilenameValidationError } = require('../temporary');

/** @typedef {import('../random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../temporary').Temporary} Temporary */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {Temporary} temporary - The temporary storage capability.
 */

/**
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const uploadMiddleware = upload.makeUpload();
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

        // Store all uploaded file buffers and mark the request done in a
        // single atomic LevelDB batch write.
        const blobs = files.map((f) => ({ filename: f.originalname, data: f.buffer }));
        try {
            await capabilities.temporary.storeBlobsAndMarkDone(reqId, blobs);
        } catch (error) {
            capabilities.logger.logError(
                {
                    error: error instanceof Error ? error.message : String(error),
                    error_stack: error instanceof Error ? error.stack : undefined,
                    path: req.path,
                    request_identifier: reqId.identifier,
                },
                'Upload failed - temporary storage error'
            );
            if (isFilenameValidationError(error)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid filename in upload',
                });
            }
            return res.status(500).json({
                success: false,
                error: 'Failed to store uploaded files',
            });
        }

        const uploaded = files.map((f) => f.originalname);
        capabilities.logger.logInfo(
            { files: uploaded, request_identifier: reqId.identifier },
            'Files uploaded'
        );
        return res.json({ success: true, files: uploaded });
    });
    return router;
}

module.exports = { makeRouter };
