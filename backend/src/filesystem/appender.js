/**
 *
 * Purpose:
 *   This module provides a unified abstraction for safely appending content to existing files
 *   in the filesystem, decoupling low-level fs.appendFile calls from application logic.
 *
 * Why this Module Exists:
 *   Direct filesystem operations can scatter try/catch blocks and inconsistent error handling
 *   throughout the codebase. Centralizing appending logic here ensures a single place to
 *   manage and categorize errors, keeping application code clean and maintainable.
 *
 * Conceptual Design Principles:
 *   • Single Responsibility - Focused solely on the semantics of file appending.
 *   • Error Categorization - Distinguishes between different appending failures (FileAppenderError)
 *     for precise caller handling.
 *   • Promise-Based API - Leverages async/await for clear asynchronous flows.
 *   • Factory Pattern - Exposes a make() function for easy dependency injection or mocking.
 */

const fs = require("fs").promises;
const path = require("path");

class FileAppenderError extends Error {
    /**
     * @param {string} message
     * @param {string} filePath
     */
    constructor(message, filePath) {
        super(message);
        this.name = "FileAppenderError";
        this.filePath = filePath;
    }
}

/**
 * Checks if the error is a FileAppenderError.
 * @param {unknown} object - The error to check.
 * @returns {object is FileAppenderError}
 */
function isFileAppenderError(object) {
    return object instanceof FileAppenderError;
}

/**
 * @typedef {import('./file').ExistingFile} ExistingFile
 */

/**
 * @typedef {object} FileAppender
 * @property {typeof appendFile} appendFile
 */

/**
 * Appends content to an existing file.
 * @param {ExistingFile} file - The existing file to append to.
 * @param {string} content - The content to append to the file.
 * @returns {Promise<void>} - A promise that resolves when the content is appended.
 */
async function appendFile(file, content) {
    try {
        // Ensure the directory exists
        await fs.mkdir(path.dirname(file.path), { recursive: true });
        // Append the content to the file
        await fs.appendFile(file.path, content);
    } catch (err) {
        throw new FileAppenderError(
            `Failed to append to file: ${file.path}`,
            file.path
        );
    }
}

/**
 * Creates a FileAppender instance.
 * @returns {FileAppender} - A FileAppender instance.
 */
function make() {
    return {
        appendFile,
    };
}

module.exports = {
    isFileAppenderError,
    make,
};
