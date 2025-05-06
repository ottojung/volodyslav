const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const logger = require('../logger');
const { fromRequest, getTargetDirectory, markDone } = require('../request_identifier');
const { transcribeFile, InputNotFound } = require('../transcribe');

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

    const rawDir = req.query.input_dir;
    logger.info({ request_identifier: reqId, input_dir: rawDir }, 'Batch transcription request received');
    if (!rawDir) {
        return res
            .status(400)
            .json({ success: false, error: 'Please provide the input_dir parameter' });
    }

    const inputDir = String(rawDir);
    const resolvedDir = path.resolve(inputDir);
    const targetDir = getTargetDirectory(reqId);
    const entries = await fs.readdir(resolvedDir);
    for (const file of entries) {
        const inputPath = path.join(resolvedDir, file);
        const outputFile = `${file}.json`;
        const outputPath = path.join(targetDir, outputFile);
        await transcribeFile(inputPath, outputPath);
    }
    markDone(reqId);

    logger.info({ request_identifier: reqId }, 'Batch transcription successful');
    return res.json({ success: true });
});

module.exports = router;
