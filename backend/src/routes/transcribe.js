const express = require('express');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { uploadDir: storageDir } = require('../config');
const { openaiAPIKey } = require('../environment');
// Instantiate client
const openai = new OpenAI({ apiKey: openaiAPIKey() });
const logger = require('../logger');

const router = express.Router();

// ensure we can parse JSON bodies
router.use(express.json());

const TRANSCRIBER_MODEL = 'gpt-4o-mini-transcribe';

/**
 * Query params:
 *    ?input=/absolute/path/to/file.wav
 *    &output=transcript.json
 */
router.get('/transcribe', async (req, res) => {
    try {
        // pull from query
        const rawIn = req.query.input;
        const rawOut = req.query.output;
        // Log the transcription request
        logger.info({ input: rawIn, output: rawOut }, 'Transcription request received');
        if (!rawIn || !rawOut) {
            return res
                .status(400)
                .json({ success: false, error: 'Please provide both input and output parameters' });
        }

        // normalize
        const inputPath = path.resolve(String(rawIn));
        const outputFile = path.basename(String(rawOut));
        const outputPath = path.join(storageDir, outputFile);

        // Check that the input file exists
        if (!fs.existsSync(inputPath)) {
            return res
                .status(404)
                .json({ success: false, error: 'Input file not found' });
        }

        // Make the API call
        const response_text = await openai.audio.transcriptions.create({
            file: fs.createReadStream(inputPath),
            model: TRANSCRIBER_MODEL,
            response_format: 'text',
        });

        // Wrap into an abstracted structure
        const wrapped = {
            text: response_text,
            transcriber: {
                name: TRANSCRIBER_MODEL,
                creator: "OpenAI",
            },
        };

        // Persist full JSON to disk
        fs.writeFileSync(
            outputPath,
            JSON.stringify(wrapped, null, 2),
            'utf8'
        );

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
