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
 * @property {typeof isFileStable} isFileStable
 */

class ExplicitClass {
    /**
     * The path to the file.
     * @type {string}
     */
    path;

    /**
     * This is a value that is never actually assigned.
     * Its purpose is to make `Explicit` a nominal type.
     * @private
     * @type {undefined}
     */
    __brand;

    /**
     * @param {string} path - The path to the file.
     */
    constructor(path) {
        this.path = path;
        if (this.__brand !== undefined) {
            throw new Error(
                "Explicit is a nominal type and should not be instantiated directly."
            );
        }
    }
}

/** @typedef {ExplicitClass} Explicit */

/**
 * Checks if a file exists and is a regular file.
 * @param {string} filePath - The path to the file to check.
 * @returns {Promise<Explicit?>} - A promise that resolves with the proof object if the file exists and is a regular file, null otherwise.
 */
async function fileExists(filePath) {
    try {
        const stats = await fs.stat(filePath);
        const exists = stats.isFile();
        return exists ? new ExplicitClass(filePath) : null;
    } catch (err) {
        if (
            err !== null &&
            typeof err === "object" &&
            "code" in err &&
            err.code === "ENOENT"
        ) {
            return null;
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
 * @throws {FileCheckerError} - If the file does not exist.
 */
async function instanciate(path) {
    const proof = await fileExists(path);
    if (!proof) {
        throw new FileCheckerError(`File does not exist: ${path}`, path);
    }
    return await fromExisting(path, proof);
}

/**
 * Checks if a file is stable (not currently being written to).
 * A file is considered stable if:
 * 1. It hasn't been modified for at least the specified age threshold
 * 2. Its size hasn't changed between two checks separated by a delay
 *
 * @param {ExistingFile} file - The path to the file to check.
 * @param {object} options - Stability check options.
 * @param {number} [options.minAgeMs=300000] - Minimum age in milliseconds (default: 5 minutes).
 * @param {number} [options.sizeCheckDelayMs=30000] - Delay between size checks in milliseconds (default: 30 second).
 * @returns {Promise<boolean>} - A promise that resolves with true if the file is stable, false otherwise.
 */
async function isFileStable(file, options = {}) {
    const { minAgeMs = 300000, sizeCheckDelayMs = 30000 } = options; // 5 minutes, 30 seconds default

    try {
        // First check: get initial file stats
        const initialStats = await fs.stat(file.path);
        const now = Date.now();
        const fileModifiedTime = initialStats.mtime.getTime();
        const ageMs = now - fileModifiedTime;

        if (ageMs < minAgeMs) {
            return false; // File was modified too recently
        }

        // Check 2: File size stability - check that size doesn't change
        const initialSize = initialStats.size;

        // Wait a short time and check size again
        await new Promise((resolve) => setTimeout(resolve, sizeCheckDelayMs));

        const finalStats = await fs.stat(file.path);
        const finalSize = finalStats.size;

        // File is stable if size hasn't changed
        return initialSize === finalSize;
    } catch (err) {
        if (
            err !== null &&
            typeof err === "object" &&
            "code" in err &&
            err.code === "ENOENT"
        ) {
            return false; // File doesn't exist
        }

        throw new FileCheckerError(
            `Failed to check file stability: ${file.path}`,
            file.path
        );
    }
}

/**
 * Creates a FileChecker instance.
 * @returns {FileChecker} - A FileChecker instance.
 */
function make() {
    return {
        fileExists,
        instanciate,
        isFileStable,
    };
}

module.exports = {
    isFileCheckerError,
    make,
};
