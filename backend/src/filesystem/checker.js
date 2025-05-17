/**
 * @module checker
 *
 * Purpose:
 *   This module provides a unified abstraction for safely checking the existence of files
 *   in the filesystem, decoupling low-level fs.stat calls from application logic.
 *
 * Why this Module Exists:
 *   Direct filesystem operations can scatter try/catch blocks and inconsistent error handling
 *   throughout the codebase. Centralizing file existence checking logic here ensures a single place to
 *   manage and categorize errors, keeping application code clean and maintainable.
 *
 * Conceptual Design Principles:
 *   • Single Responsibility - Focused solely on the semantics of file existence checking.
 *   • Error Categorization - Distinguishes between different checking failures (FileCheckerError)
 *     for precise caller handling.
 *   • Promise-Based API - Leverages async/await for clear asynchronous flows.
 *   • Factory Pattern - Exposes a make() function for easy dependency injection or mocking.
 */

const { fromExisting } = require("./file");

const fs = require("fs").promises;

/** @typedef {import('./file').ExistingFile} ExistingFile */

class FileCheckerError extends Error {
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
 * Checks if the error is a FileCheckerError.
 * @param {unknown} object - The error to check.
 * @returns {object is FileCheckerError}
 */
function isFileCheckerError(object) {
    return object instanceof FileCheckerError;
}

/**
 * @typedef {object} FileChecker
 * @property {typeof fileExists} fileExists
 * @property {typeof instanciate} instanciate
 */

/**
 * Checks if a file exists and is a regular file.
 * @param {string} filePath - The path to the file to check.
 * @returns {Promise<boolean>} - A promise that resolves with true if the file exists and is a regular file, false otherwise.
 */
async function fileExists(filePath) {
    try {
        const stats = await fs.stat(filePath);
        return stats.isFile();
    } catch (err) {
        if (
            err !== null &&
            typeof err === "object" &&
            "code" in err &&
            err.code === "ENOENT"
        ) {
            return false;
        }

        throw new FileCheckerError(
            `Failed to check file existence: ${filePath}`,
            filePath
        );
    }
}

/**
 * Creates an ExistingFile instance from a file path.
 * @param {string} path - The path to the file.
 * @returns {Promise<ExistingFile>} - A promise that resolves to an ExistingFile instance.
 */
async function instanciate(path) {
    return await fromExisting(path);
}

/**
 * Creates a FileChecker instance.
 * @returns {FileChecker} - A FileChecker instance.
 */
function make() {
    return {
        fileExists,
        instanciate,
    };
}

module.exports = {
    isFileCheckerError,
    make,
};
