/**
 *
 * Purpose:
 *   This module provides a unified abstraction for safely creating files and directories
 *   in the filesystem, decoupling low-level fs.writeFile and fs.mkdir calls from application logic.
 *
 * Why this Module Exists:
 *   Direct filesystem operations can scatter try/catch blocks and inconsistent error handling
 *   throughout the codebase. Centralizing creation logic here ensures a single place to
 *   manage and categorize errors, keeping application code clean and maintainable.
 *
 * Conceptual Design Principles:
 *   • Single Responsibility - Focused solely on the semantics of file and directory creation.
 *   • Error Categorization - Distinguishes between different creation failures (FileCreatorError)
 *     for precise caller handling.
 *   • Promise-Based API - Leverages async/await for clear asynchronous flows.
 *   • Factory Pattern - Exposes a make() function for easy dependency injection or mocking.
 */

const fs = require("fs").promises;
const path = require("path");

class FileCreatorError extends Error {
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
 * Checks if the error is a FileCreatorError.
 * @param {unknown} object - The error to check.
 * @returns {object is FileCreatorError}
 */
function isFileCreatorError(object) {
    return object instanceof FileCreatorError;
}

/** @typedef {{createFile: typeof createFile, createDirectory: typeof createDirectory}} FileCreator */

/**
 * Creates a file at the specified path with the given content.
 * @param {string} filePath - The path to the file to create.
 * @param {string} [content=""] - The content to write to the file. Defaults to empty string.
 * @returns {Promise<void>} - A promise that resolves when the file is created.
 */
async function createFile(filePath, content = "") {
    try {
        // Ensure the directory exists
        await createDirectory(path.dirname(filePath));

        // Write the file
        await fs.writeFile(filePath, content);
    } catch (err) {
        throw new FileCreatorError(
            `Failed to create file: ${filePath}`,
            filePath
        );
    }
}

/**
 * Creates a directory at the specified path.
 * @param {string} dirPath - The path to the directory to create.
 * @returns {Promise<void>} - A promise that resolves when the directory is created.
 */
async function createDirectory(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (err) {
        throw new FileCreatorError(
            `Failed to create directory: ${dirPath}`,
            dirPath
        );
    }
}

function make() {
    return {
        createFile,
        createDirectory,
    };
}

module.exports = {
    isFileCreatorError,
    make,
};
