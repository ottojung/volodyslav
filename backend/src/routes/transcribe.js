const express = require('express');
const { logError, logInfo } = require('../logger');
const { fromRequest } = require('../request_identifier');
const { transcribeRequest, isInputNotFound } = require('../transcribe');

const router = express.Router();

/**
 * Query params:
 *    ?input=/absolute/path/to/file.wav
 *    &request_identifier=0x123
 */
router.get('/transcribe', async (req, res) => {
    // pull request_identifier and validate
    let reqId;
    try {
        reqId = fromRequest(req);
    } catch {
        logError({
            error: 'Missing request identifier',
            path: req.path,
            query: req.query,
            headers: req.headers
        }, 'Transcription request failed - invalid request identifier');
        return res
            .status(400)
            .json({ success: false, error: 'Missing request_identifier parameter' });
    }

    // pull input and output params
    /** @type {any} */
    const query = req.query;
    const rawIn = query['input'];
    // Log the transcription request
    logInfo({ 
        request_identifier: reqId, 
        input: rawIn,
        client_ip: req.ip,
        user_agent: req.get('user-agent')
    }, 'Transcription request received');

    if (!rawIn) {
        logError({
            request_identifier: reqId,
            error: 'Missing input parameter',
            query: req.query
        }, 'Transcription request failed - missing input');
        return res
            .status(400)
            .json({ success: false, error: 'Please provide the input parameter' });
    }

    // normalize input and determine paths
    const inputPath = String(rawIn);
    try {
        await transcribeRequest(inputPath, reqId);
    } catch (error) {
        if (isInputNotFound(error)) {
            logError({
                request_identifier: reqId,
                error: 'Input file not found',
                input_path: inputPath,
                error_details: error.message
            }, 'Transcription request failed - file not found');
            return res
                .status(404)
                .json({ success: false, error: 'Input file not found' });
        } else {
            logError({
                request_identifier: reqId,
                error: error instanceof Error ? error.message : String(error),
                error_name: error instanceof Error ? error.name : 'Unknown',
                error_stack: error instanceof Error ? error.stack : undefined,
                input_path: inputPath
            }, 'Transcription request failed - unexpected error');
            return res
                .status(500)
                .json({ success: false, error: 'Internal server error during transcription' });
        }
    }

    // Log successful transcription
    logInfo({ request_identifier: reqId, input_path: inputPath }, 'Transcription successful');
    return res.json({ success: true });
});

module.exports = router;
