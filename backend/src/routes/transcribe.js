const express = require('express');
const path = require('path');
const logger = require('../logger');
const { fromRequest } = require('../request_identifier');
const { transcribeRequest } = require('../transcribe');

const router = express.Router();

/**
 * Query params:
 *    ?input=/absolute/path/to/file.wav
 *    &request_identifier=0x123
 */
router.get('/transcribe', async (req, res) => {
    try {
        // pull request_identifier and validate
        let reqId;
        try {
            reqId = fromRequest(req);
        } catch {
            return res
                .status(400)
                .json({ success: false, error: 'Missing request_identifier parameter' });
        }

        // pull input and output params
        const rawIn = req.query.input;
        // Log the transcription request
        logger.info({ request_identifier: reqId, input: rawIn }, 'Transcription request received');
        if (!rawIn) {
            return res
                .status(400)
                .json({ success: false, error: 'Please provide the input parameter' });
        }

        // normalize input and determine paths
        const inputPath = path.resolve(String(rawIn));
        await transcribeRequest(inputPath, reqId);

        // Log successful transcription
        logger.info({ reqId }, 'Transcription successful');
        return res.json({ success: true });
    } catch (err) {
        logger.error({ err }, 'Transcription error');

        let message;
        if (err instanceof Error) {
            message = err.message;
        } else {
            message = String(err);
        }

        return res
            .status(500)
            .json({ success: false, error: message || 'Uknown error' });
    }
});

module.exports = router;
