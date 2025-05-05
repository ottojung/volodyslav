const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { openaiAPIKey } = require('./environment');

// Instantiate client
const openai = new OpenAI({ apiKey: openaiAPIKey() });

const TRANSCRIBER_MODEL = 'gpt-4o-mini-transcribe';

/**
 * @typedef {{ text: string, transcriber: { name: string, creator: string } }} Transcription
 */

/**
 * Transcribe input stream.
 * @param {import('fs').ReadStream} file_stream
 * @returns {Promise<Transcription>}
 */
async function transcribe(file_stream) {
    // Make the API call
    const response_text = await openai.audio.transcriptions.create({
        file: file_stream,
        model: TRANSCRIBER_MODEL,
        response_format: 'text',
    });

    // Wrap into an abstracted structure
    return {
        text: response_text,
        transcriber: {
            name: TRANSCRIBER_MODEL,
            creator: "OpenAI",
        },
    };
}


/**
 * Transcribe input file.
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
async function transcribeFiles(inputPath, outputPath) {
    // Check that the input file exists
    const file_stream = fs.createReadStream(inputPath);
    const transcription = await transcribe(file_stream);

    // Persist full JSON to disk
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(
        outputPath,
        JSON.stringify(transcription, null, 2),
        'utf8'
    );
}

module.exports = {
    transcribe,
    transcribeFiles,
};
