/**
 *
 * Purpose:
 *   This module provides a unified abstraction for safely writing content to existing files
 *   in the filesystem, decoupling low-level fs.writeFile calls from application logic.
 *
 * Why this Module Exists:
 *   Direct filesystem operations can scatter try/catch blocks and inconsistent error handling
 *   throughout the codebase. Centralizing writing logic here ensures a single place to
 *   manage and categorize errors, keeping application code clean and maintainable.
 *
 * Conceptual Design Principles:
 *   • Single Responsibility - Focused solely on the semantics of file writing.
 *   • Error Categorization - Distinguishes between different writing failures (FileWriterError)
 *     for precise caller handling.
 *   • Promise-Based API - Leverages async/await for clear asynchronous flows.
 *   • Factory Pattern - Exposes a make() function for easy dependency injection or mocking.
 */

const fs = require("fs").promises;
const path = require("path");

class FileWriterError extends Error {
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
 * Checks if the error is a FileWriterError.
 * @param {unknown} object - The error to check.
 * @returns {object is FileWriterError}
 */
function isFileWriterError(object) {
    return object instanceof FileWriterError;
}

/**
 * @typedef {import('./file').ExistingFile} ExistingFile
 */

/**
 * @typedef {object} FileWriter
 * @property {typeof writeFile} writeFile
 */

/**
 * Writes content to an existing file.
 * @param {ExistingFile} file - The existing file to write to.
 * @param {string} content - The content to write to the file.
 * @returns {Promise<void>} - A promise that resolves when the content is written.
 */
async function writeFile(file, content) {
    try {
        // Ensure the directory exists
        await fs.mkdir(path.dirname(file.path), { recursive: true });
        // Write the content to the file
        await fs.writeFile(file.path, content);
    } catch (err) {
        throw new FileWriterError(
            `Failed to write to file: ${file.path}`,
            file.path
        );
    }
}

/**
 * Creates a FileWriter instance.
 * @returns {FileWriter} - A FileWriter instance.
 */
function make() {
    return {
        writeFile,
    };
}

module.exports = {
    isFileWriterError,
    make,
};
