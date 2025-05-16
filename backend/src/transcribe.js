const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { openaiAPIKey } = require('./environment');
const { makeDirectory, markDone } = require('./request_identifier');
const memconst = require('./memconst');
const creatorMake = require('./creator');

// Instantiate client
const openai = memconst(() => new OpenAI({ apiKey: openaiAPIKey() }));

const TRANSCRIBER_MODEL = 'gpt-4o-mini-transcribe';

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
 * Checks if the given object is an instance of InputNotFound.
 * @param {unknown} object
 * @returns {object is InputNotFound}
 */
function isInputNotFound(object) {
    return object instanceof InputNotFound;
}

/** @typedef {import('./creator').Creator} Creator */

/**
 * @typedef {Object} Transcriber
 * @property {string} name - The name of the transcriber.
 * @property {string} creator - The creator of the transcriber.
 */

/**
 * @typedef {Object} Transcription
 * @property {string} text - The transcribed text
 * @property {Transcriber} transcriber - The transcriber used
 * @property {Creator} creator - The creator of the transcription
 */

/**
 * Transcribe input stream.
 * @param {import('fs').ReadStream} file_stream
 * @returns {Promise<Transcription>}
 */
async function transcribeStream(file_stream) {
    // Make the API call
    const response_text = await openai().audio.transcriptions.create({
        file: file_stream,
        model: TRANSCRIBER_MODEL,
        response_format: 'text',
    });

    const creator = await creatorMake();

    // Wrap into an abstracted structure
    return {
        text: response_text,
        transcriber: {
            name: TRANSCRIBER_MODEL,
            creator: "OpenAI",
        },
        creator,
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
    const targetDir = await makeDirectory(reqId);
    const outputPath = path.join(targetDir, outputFile);
    try {
        await transcribeFile(inputPath, outputPath);
    } finally {
        await markDone(reqId);
    }
}

module.exports = {
    isInputNotFound,
    transcribeStream,
    transcribeFile,
    transcribeRequest,
};
