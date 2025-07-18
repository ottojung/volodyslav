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
        this.name = "ReaderError";
        this.filePath = filePath;
    }
}

/**
 * Checks if the error is a ReaderError.
 * @param {unknown} object - The object to check.
 * @returns {object is ReaderError}
 */
function isReaderError(object) {
    return object instanceof ReaderError;
}

/**
 * Reads a file as a UTF-8 string.
 * @param {string} filePath - The path to the file to read.
 * @returns {Promise<string>} - A promise that resolves to the file contents as a string.
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
 * @param {string} filePath - The path to the file to read.
 * @returns {Promise<Buffer>} - A promise that resolves to the file contents as a Buffer.
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
 * @param {import("./file").ExistingFile} file - The existing file to create a stream for.
 * @returns {import('fs').ReadStream}
 * @throws {ReaderError} - If the stream cannot be created (synchronously throws for missing file, etc.)
 */
function createReadStream(file) {
    const fsModule = require("fs");
    try {
        // Leave encoding undefined so consumers can decide how to interpret the
        // data. This keeps the reader suitable for both text and binary files.
        return fsModule.createReadStream(file.path);
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
