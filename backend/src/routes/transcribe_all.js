const express = require('express');
const { logInfo } = require('../logger');
const { fromRequest } = require('../request_identifier');
const { transcribeAllRequest, InputDirectoryAccess } = require('../transcribe_all');

const router = express.Router();

/**
 * Batch transcription endpoint.
 * Query params:
 *    ?input_dir=/absolute/path/to/directory
 *    &request_identifier=0x123
 */
router.get('/transcribe_all', async (req, res) => {
    let reqId;
    try {
        reqId = fromRequest(req);
    } catch {
        return res
            .status(400)
            .json({ success: false, error: 'Missing request_identifier parameter' });
    }

    /** @type {any} */
    const query = req.query;
    const rawDir = query['input_dir'];
    logInfo({ request_identifier: reqId, input_dir: rawDir }, 'Batch transcription request received');
    if (!rawDir) {
        return res
            .status(400)
            .json({ success: false, error: 'Please provide the input_dir parameter' });
    }

    const inputDir = String(rawDir);
    let result;
    try {
        result = await transcribeAllRequest(inputDir, reqId);
        if (result.failures.length > 0) {
            return res
                .status(500)
                .json({ success: false, result });
        }
    } catch (/** @type {unknown} */ error) {
        if (error instanceof InputDirectoryAccess) {
            return res
                .status(404)
                .json({ success: false, error: error.message });
        }
    }

    logInfo({ request_identifier: reqId, result }, 'Batch transcription successful');
    return res.json({ success: true, result });
});

module.exports = router;
