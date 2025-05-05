const express = require('express');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { fromRequest, getTargetDirectory, markDone } = require('../request_identifier');
const { transcribeFiles } = require('../transcribe');

const router = express.Router();

// ensure we can parse JSON bodies
router.use(express.json());

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
        const is_exists = await fs.existsSync(inputPath);
        if (!is_exists) {
            return res
                .status(404)
                .json({ success: false, error: 'Input file not found' });
        }

        const outputFile = path.basename('transcription.json');
        // determine target directory for this request and ensure it exists
        const targetDir = getTargetDirectory(reqId);
        const outputPath = path.join(targetDir, outputFile);
        await transcribeFiles(inputPath, outputPath);
        markDone(reqId);

        // Log successful transcription
        logger.info({ outputPath }, 'Transcription successful');
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
