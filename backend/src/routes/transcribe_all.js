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

    let entries;
    try {
        entries = await fs.readdir(resolvedDir);
    } catch {
        return res
            .status(404)
            .json({ success: false, error: 'Input directory not found' });
    }

    const successes = [];
    const errorsList = [];
    for (const file of entries) {
        const inputPath = path.join(resolvedDir, file);
        const outputFile = `${file}.json`;
        const outputPath = path.join(targetDir, outputFile);
        try {
            await transcribeFile(inputPath, outputPath);
            successes.push(file);
        } catch (/** @type {unknown} */ err) {
            const message = err instanceof Error ? err.message : String(err);
            errorsList.push({ file, message });
        }
    }

    await markDone(reqId);
    if (errorsList.length > 0) {
        return res
            .status(500)
            .json({ success: false, errors: errorsList, successes });
    }

    logger.info({ request_identifier: reqId, successes }, 'Batch transcription successful');
    return res.json({ success: true, successes });
});

module.exports = router;
