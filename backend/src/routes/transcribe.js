const express = require('express');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { uploadDir: storageDir } = require('../config');

// Initialize OpenAI
if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable is required');
}

// Instantiate client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const router = express.Router();

// ensure we can parse JSON bodies
router.use(express.json());

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
        const resp = await openai.audio.transcriptions.create({
            file: fs.createReadStream(inputPath),
            model: 'whisper-1',
            response_format: 'verbose_json',   // you can choose 'json', 'verbose_json', etc.
        });

        // Persist full JSON to disk
        fs.writeFileSync(
            outputPath,
            JSON.stringify(resp, null, 2),
            'utf8'
        );

        return res.json({ success: true });
    } catch (err) {
        console.error('Transcription error:', err);

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
