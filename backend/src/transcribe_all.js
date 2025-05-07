const fs = require("fs/promises");
const path = require("path");
const { makeDirectory, markDone } = require("./request_identifier");
const { transcribeFile } = require("./transcribe");

/**
 * @class
 */
class InputDirectoryAccess extends Error {
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
 * @typedef {{ file: string, message: string }} TranscriptionFailure
 */

/**
 * @typedef {{ successes: string[], failures: TranscriptionFailure[] }} TranscriptionStatus
 */

/**
 * Transcribe a request with a generic namer.
 * @param {string} inputDir
 * @param {(file: string) => string} targetFun
 * @returns {Promise<TranscriptionStatus>}
 */
async function transcribeAllGeneric(inputDir, targetFun) {
    const resolvedDir = path.resolve(inputDir);

    let entries;
    try {
        entries = await fs.readdir(resolvedDir);
    } catch {
        throw new InputDirectoryAccess(
            `Could not read input directory`,
            resolvedDir
        );
    }

    const successes = [];
    const failures = [];
    for (const filename of entries) {
        const inputPath = path.join(resolvedDir, filename);
        const outputPath = targetFun(filename);
        try {
            await transcribeFile(inputPath, outputPath);
            successes.push(filename);
        } catch (/** @type {unknown} */ err) {
            const internalMessage = err instanceof Error ? err.message : String(err);
            const message = `Transcription failed for ${filename}: ${internalMessage}`;
            failures.push({ file: filename, message });
        }
    }

    return { successes, failures };
}

/**
 * Transcribe a request.
 * @param {string} inputDir
 * @param {string} targetDir
 * @returns {Promise<TranscriptionStatus>}
 */
async function transcribeAllDirectory(inputDir, targetDir) {
    /**
     * @param {string} filename
     * @returns {string}
     */
    function namer(filename) {
        const targetName = `${filename}.json`;
        return path.join(targetDir, targetName);
    }

    return transcribeAllGeneric(inputDir, namer);
}

/**
 * Transcribe a request.
 * @param {string} inputDir
 * @param {import('./request_identifier').RequestIdentifier} reqId
 * @returns {Promise<TranscriptionStatus>}
 */
async function transcribeAllRequest(inputDir, reqId) {
    const targetDir = await makeDirectory(reqId);
    const result = await transcribeAllDirectory(inputDir, targetDir);
    await markDone(reqId);
    return result;
}

module.exports = {
    InputDirectoryAccess,
    transcribeAllGeneric,
    transcribeAllDirectory,
    transcribeAllRequest,
};
