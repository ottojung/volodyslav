/**
 * @module reader
 *
 * Purpose:
 *   Provides a unified abstraction for reading the contents of files as text or Buffer.
 *   Centralizes error handling and file reading logic for maintainability and testability.
 *
 * Design Principles:
 *   • Single Responsibility - Only handles file reading, not existence or type checking.
 *   • Error Categorization - Throws ReaderError for read failures.
 *   • Promise-Based API - Uses async/await for clear asynchronous flows.
 *   • Factory Pattern - Exposes a make() function for DI/mocking.
 */

const fs = require("fs").promises;

/**
 * Error thrown when file reading fails.
 */
class ReaderError extends Error {
    /**
     * @param {string} message
     * @param {string} filePath
     */
    constructor(message, filePath) {
        super(message);
        this.filePath = filePath;
    }
}

/**
 * Checks if the error is a ReaderError.
 * @param {unknown} object
 * @returns {object is ReaderError}
 */
function isReaderError(object) {
    return object instanceof ReaderError;
}

/**
 * Reads a file as a UTF-8 string.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readFileAsText(filePath) {
    try {
        return await fs.readFile(filePath, "utf8");
    } catch (err) {
        throw new ReaderError(
            `Failed to read file as text: ${filePath}`,
            filePath
        );
    }
}

/**
 * Reads a file as a Buffer.
 * @param {string} filePath
 * @returns {Promise<Buffer>}
 */
async function readFileAsBuffer(filePath) {
    try {
        return await fs.readFile(filePath);
    } catch (err) {
        throw new ReaderError(
            `Failed to read file as buffer: ${filePath}`,
            filePath
        );
    }
}

/**
 * Creates a readable stream for a file.
 * @param {import("./file").ExistingFile} file
 * @returns {import('fs').ReadStream}
 * @throws {ReaderError} - If the stream cannot be created (synchronously throws for missing file, etc.)
 */
function createReadStream(file) {
    const fsModule = require("fs");
    try {
        return fsModule.createReadStream(file.path, {
            encoding: "utf8",
        });
    } catch (err) {
        throw new ReaderError(
            `Failed to create read stream: ${file.path}`,
            file.path
        );
    }
}

/**
 * @typedef {object} FileReader
 * @property {typeof readFileAsText} readFileAsText
 * @property {typeof readFileAsBuffer} readFileAsBuffer
 * @property {typeof createReadStream} createReadStream
 */

/**
 * Creates a FileReader instance.
 * @returns {FileReader}
 */
function make() {
    return {
        readFileAsText,
        readFileAsBuffer,
        createReadStream,
    };
}

module.exports = {
    isReaderError,
    make,
};
