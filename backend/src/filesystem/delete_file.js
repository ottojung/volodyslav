/**
 *
 * Purpose:
 *   This module provides a unified abstraction for safely removing files from the filesystem,
 *   decoupling low-level fs.unlink calls from application logic.
 *
 * Why this Module Exists:
 *   Direct filesystem operations can scatter try/catch blocks and inconsistent error handling
 *   throughout the codebase. Centralizing deletion logic here ensures a single place to
 *   manage and categorize errors, keeping application code clean and maintainable.
 *
 * Conceptual Design Principles:
 *   • Single Responsibility - Focused solely on the semantics of file deletion.
 *   • Error Categorization - Distinguishes between missing files (FileNotFoundError)
 *     and other deletion failures (FileDeleterError) for precise caller handling.
 *   • Promise-Based API - Leverages async/await for clear asynchronous flows.
 *   • Factory Pattern - Exposes a make() function for easy dependency injection or mocking.
 */

const fs = require("fs").promises;

class FileDeleterError extends Error {
    /**
     * @param {string} message
     * @param {string} filePath
     */
    constructor(message, filePath) {
        super(message);
        this.filePath = filePath;
    }
}

class FileNotFoundError extends FileDeleterError {
    /**
     * @param {string} filePath
     */
    constructor(filePath) {
        super(`File not found: ${filePath}`, filePath);
    }
}

class FileDeleterClass {
    /**
     * @type {undefined}
     * @private
     */
    __brand;

    /**
     * Deletes a file at the specified path.
     * @param {string} filePath - The path to the file to delete.
     * @returns {Promise<void>} - A promise that resolves when the file is deleted.
     */
    async delete(filePath) {
        try {
            await fs.unlink(filePath);
        } catch (err) {
            if (
                err instanceof Error &&
                "code" in err &&
                err.code === "ENOENT"
            ) {
                throw new FileNotFoundError(filePath);
            } else {
                throw new FileDeleterError(
                    `Failed to delete file: ${filePath}`,
                    filePath
                );
            }
        }
    }
}

function make() {
    return new FileDeleterClass();
}

/** @typedef {FileDeleterClass} FileDeleter */

module.exports = {
    FileDeleterError,
    FileNotFoundError,
    make,
};
