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

const DELETE_RETRY_DELAY_MS = 200;
const DELETE_RETRY_ATTEMPTS = 25;

class FileDeleterError extends Error {
    /**
     * @param {string} message
     * @param {string} filePath
     */
    constructor(message, filePath) {
        super(message);
        this.name = "FileDeleterError";
        this.filePath = filePath;
    }
}

/**
 * Checks if the error is a FileDeleterError.
 * @param {unknown} object - The error to check.
 * @returns {object is FileDeleterError}
 */
function isFileDeleterError(object) {
    return object instanceof FileDeleterError;
}

class FileNotFoundError extends Error {
    /**
     * @param {string} filePath
     */
    constructor(filePath) {
        super(`File not found: ${filePath}`);
        this.name = "FileNotFoundError";
        this.filePath = filePath;
    }
}

/**
 * Checks if the error is a FileNotFoundError.
 * @param {unknown} object - The error to check.
 * @returns {object is FileNotFoundError}
 */
function isFileNotFoundError(object) {
    return object instanceof FileNotFoundError;
}

/**
 * Deletes a file at the specified path.
 * @param {string} filePath - The path to the file to delete.
 * @returns {Promise<void>} - A promise that resolves when the file is deleted.
 */
async function deleteFile(filePath) {
    try {
        await fs.unlink(filePath);
    } catch (err) {
        if (err instanceof Object && "code" in err && err.code === "ENOENT") {
            throw new FileNotFoundError(filePath);
        } else {
            const msg = err instanceof Error ? err.message : String(err);
            throw new FileDeleterError(
                `Failed to delete file: ${filePath}: ${msg}`,
                filePath
            );
        }
    }
}

/**
 * Deletes a directory at the specified path.
 * @param {string} directoryPath - The path to the directory to delete.
 * @returns {Promise<void>} - A promise that resolves when the directory is deleted.
 */
async function deleteDirectory(directoryPath) {
    let lastError = null;
    for (let attempt = 0; attempt < DELETE_RETRY_ATTEMPTS; attempt++) {
        try {
            await fs.rm(directoryPath, { recursive: true });
            return;
        } catch (err) {
            const isObject = typeof err === 'object' && err !== null && "code" in err;
            const code = isObject && err.code;
            if (isObject && code === "ENOENT") {
                return;
            }
            if (isObject && code === "ENOTEMPTY") {
                lastError = err;
                await new Promise((resolve) =>
                    setTimeout(resolve, DELETE_RETRY_DELAY_MS)
                );
                continue;
            }
            const msg = err instanceof Error ? err.message : String(err);
            throw new FileDeleterError(
                `Failed to delete directory: ${directoryPath}: (${code}) ${msg}`,
                directoryPath
            );
        }
    }
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    const isObject = typeof lastError === 'object' && lastError !== null && "code" in lastError;
    const code = isObject && lastError.code;
    throw new FileDeleterError(
        `Failed to delete directory after ${DELETE_RETRY_ATTEMPTS} attempts: ${directoryPath}: (${code}) ${msg}`,
        directoryPath
    );
}

/**
 * @typedef {Object} FileDeleter
 * @property {typeof deleteFile} deleteFile - Deletes a file.
 * @property {typeof deleteDirectory} deleteDirectory - Deletes a directory.
 */

function make() {
    return {
        deleteFile,
        deleteDirectory,
    };
}

module.exports = {
    isFileDeleterError,
    isFileNotFoundError,
    make,
};
