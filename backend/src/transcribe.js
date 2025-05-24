const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
const { makeDirectory, markDone } = require("./request_identifier");
const creatorMake = require("./creator");
const memoize = require("@emotion/memoize").default;

/** @typedef {import('./filesystem/file').ExistingFile} ExistingFile */

/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('./filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('./filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('./filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('./subprocess/command').Command} Command */
/** @typedef {import('./environment').Environment} Environment */
/** @typedef {import('./logger').Logger} Logger */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {FileCreator} creator - A file system creator instance.
 * @property {FileChecker} checker - A file system checker instance.
 * @property {FileWriter} writer - A file system writer instance.
 * @property {Command} git - A command instance for Git operations (optional if not always used).
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 */

// Instantiate client
const openai = memoize((/** @type {string} */ apiKey) => new OpenAI({ apiKey }));

const TRANSCRIBER_MODEL = "gpt-4o-mini-transcribe";

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
 * @param {Capabilities} capabilities
 * @param {import('fs').ReadStream} file_stream
 * @returns {Promise<Transcription>}
 */
async function transcribeStream(capabilities, file_stream) {
    // Make the API call
    const apiKey = capabilities.environment.openaiAPIKey();
    const response_text = await openai(apiKey).audio.transcriptions.create({
        file: file_stream,
        model: TRANSCRIBER_MODEL,
        response_format: "text",
    });

    const creator = await creatorMake(capabilities);

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
 * @param {Capabilities} capabilities
 * @param {ExistingFile} inputFile
 * @param {string} outputPath
 * @returns {Promise<ExistingFile>}
 */
async function transcribeFile(capabilities, inputFile, outputPath) {
    const file_stream = fs.createReadStream(inputFile.path);
    const transcription = await transcribeStream(capabilities, file_stream);

    // Persist full JSON to disk
    const outputFile = await capabilities.creator.createFile(outputPath);
    await capabilities.writer.writeFile(
        outputFile,
        JSON.stringify(transcription, null, 2)
    );

    return outputFile;
}

/**
 * Transcribe a request.
 * @param {Capabilities} capabilities
 * @param {string} inputPath
 * @param {import('./request_identifier').RequestIdentifier} reqId
 * @returns {Promise<void>}
 */
async function transcribeRequest(capabilities, inputPath, reqId) {
    const outputFile = path.basename("transcription.json");
    const targetDir = await makeDirectory(capabilities, reqId);
    const outputPath = path.join(targetDir, outputFile);
    const inputFile = await capabilities.checker
        .instanciate(inputPath)
        .catch(() => {
            throw new InputNotFound(
                `Input file ${inputPath} not found.`,
                inputPath
            );
        });

    try {
        await transcribeFile(capabilities, inputFile, outputPath);
    } finally {
        await markDone(capabilities, reqId);
    }
}

module.exports = {
    isInputNotFound,
    transcribeStream,
    transcribeFile,
    transcribeRequest,
};
