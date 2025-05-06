const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { openaiAPIKey } = require('./environment');
const { getTargetDirectory, markDone } = require('./request_identifier');

// Instantiate client
const openai = new OpenAI({ apiKey: openaiAPIKey() });

const TRANSCRIBER_MODEL = 'gpt-4o-mini-transcribe';

/**
 * @class
 */
class InputNotFound extends Error {
    /** @type {string} */
    path;

    /**
     * @param {string} message
     * @param {string} path
     */
    constructor(message, path) {
        super(message);
        this.path = path;
    }
}

/**
 * @typedef {{ text: string, transcriber: { name: string, creator: string } }} Transcription
 */

/**
 * Transcribe input stream.
 * @param {import('fs').ReadStream} file_stream
 * @returns {Promise<Transcription>}
 */
async function transcribeStream(file_stream) {
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
async function transcribeFile(inputPath, outputPath) {
    const resolvedInputPath = path.resolve(inputPath);

    // Check that the input file exists
    if (!fs.existsSync(resolvedInputPath)) {
        throw new InputNotFound(
            `Input file ${resolvedInputPath} not found.`,
            resolvedInputPath,
        );
    }

    const file_stream = fs.createReadStream(resolvedInputPath);
    const transcription = await transcribeStream(file_stream);

    // Persist full JSON to disk
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(
        outputPath,
        JSON.stringify(transcription, null, 2),
        'utf8'
    );
}

/**
 * Transcribe a request.
 * @param {string} inputPath
 * @param {import('./request_identifier').RequestIdentifier} reqId
 * @returns {Promise<void>}
 */
async function transcribeRequest(inputPath, reqId) {
    const outputFile = path.basename('transcription.json');
    const targetDir = getTargetDirectory(reqId);
    const outputPath = path.join(targetDir, outputFile);
    try {
        await transcribeFile(inputPath, outputPath);
    } finally {
        await markDone(reqId);
    }
}

module.exports = {
    InputNotFound,
    transcribeStream,
    transcribeFile,
    transcribeRequest,
};
