/**
 *
 * Purpose:
 *   This module provides a unified abstraction for safely copying files in the filesystem,
 *   decoupling low-level fs.copyFile calls from application logic.
 *
 * Why this Module Exists:
 *   Direct filesystem operations can scatter try/catch blocks and inconsistent error handling
 *   throughout the codebase. Centralizing copying logic here ensures a single place to
 *   manage and categorize errors, keeping application code clean and maintainable.
 *
 * Conceptual Design Principles:
 *   • Single Responsibility - Focused solely on the semantics of file copying.
 *   • Error Categorization - Distinguishes between different copying failures (FileCopierError)
 *     for precise caller handling.
 *   • Promise-Based API - Leverages async/await for clear asynchronous flows.
 *   • Factory Pattern - Exposes a make() function for easy dependency injection or mocking.
 */

const { makeCopy } = require("./file");

class FileCopierError extends Error {
    /**
     * @param {string} message
     * @param {string} sourcePath
     * @param {string} destinationPath
     */
    constructor(message, sourcePath, destinationPath) {
        super(message);
        this.sourcePath = sourcePath;
        this.destinationPath = destinationPath;
    }
}

/**
 * Checks if the error is a FileCopierError.
 * @param {unknown} object - The error to check.
 * @returns {object is FileCopierError}
 */
function isFileCopierError(object) {
    return object instanceof FileCopierError;
}

/**
 * @typedef {import('./file').ExistingFile} ExistingFile
 */

/**
 * @typedef {object} FileCopier
 * @property {typeof copyFile} copyFile
 */

/**
 * Copies a file from source path to destination path.
 * @param {ExistingFile} existingFile - The existing file to copy.
 * @param {string} destinationPath - The path to the destination file.
 * @returns {Promise<ExistingFile>} - A promise that resolves to an ExistingFile representing the copied file.
 */
async function copyFile(existingFile, destinationPath) {
    try {
        return await makeCopy(existingFile, destinationPath);
    } catch (err) {
        throw new FileCopierError(
            `Failed to copy file from ${existingFile.path} to ${destinationPath}`,
            existingFile.path,
            destinationPath
        );
    }
}

/**
 * Creates a FileCopier instance.
 * @returns {FileCopier} - A FileCopier instance.
 */
function make() {
    return {
        copyFile,
    };
}

module.exports = {
    isFileCopierError,
    make,
};
