/**
 * Purpose:
 *   This module provides a unified abstraction for safely scanning directories in the filesystem,
 *   decoupling low-level fs.readdir calls from application logic.
 *
 * Why this Module Exists:
 *   Direct filesystem operations can scatter try/catch blocks and inconsistent error handling
 *   throughout the codebase. Centralizing directory scanning logic here ensures a single place to
 *   manage and categorize errors, keeping application code clean and maintainable.
 *
 * Conceptual Design Principles:
 *   • Single Responsibility - Focused solely on the semantics of directory scanning.
 *   • Error Categorization - Distinguishes between different scanning failures (DirScannerError)
 *     for precise caller handling.
 *   • Promise-Based API - Leverages async/await for clear asynchronous flows.
 *   • Factory Pattern - Exposes a make() function for easy dependency injection or mocking.
 */

class DirScannerError extends Error {
    /**
     * @param {string} message
     * @param {string} dirPath
     */
    constructor(message, dirPath) {
        super(message);
        this.name = "DirScannerError";
        this.dirPath = dirPath;
    }
}

/**
 * Checks if the error is a DirScannerError.
 * @param {unknown} object - The error to check.
 * @returns {object is DirScannerError}
 */
function isDirScannerError(object) {
    return object instanceof DirScannerError;
}

/**
 * @typedef {import('./file').ExistingFile} ExistingFile
 */

class DirectoryMemberClass {
    /**
     * The path to the file.
     * @type {string}
     */
    path;

    /**
     * This is a value that is never actually assigned.
     * Its purpose is to make `DirectoryMember` a nominal type.
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
                "DirectoryMember is a nominal type and should not be instantiated directly."
            );
        }
    }
}

/** @typedef {DirectoryMemberClass} DirectoryMember */

/**
 * @typedef {object} DirScanner
 * @property {typeof scanDirectory} scanDirectory
 */

/**
 * Scans a directory at the specified path and returns ExistingFile objects for its children.
 * @param {string} dirPath - The path to the directory to scan.
 * @returns {Promise<ExistingFile[]>} - A promise that resolves to an array of ExistingFile objects representing the directory contents.
 */
async function scanDirectory(dirPath) {
    const fs = require("fs").promises;
    const path = require("path");
    const { fromExisting } = require("./file");

    try {
        const files = await fs.readdir(dirPath);
        const existingFiles = [];
        
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const proof = new DirectoryMemberClass(filePath);
            const existingFile = fromExisting(filePath, proof);
            existingFiles.push(existingFile);
        }
        
        return existingFiles;
    } catch (err) {
        throw new DirScannerError(
            `Failed to scan directory: ${dirPath}`,
            dirPath
        );
    }
}

/**
 * Creates a DirScanner instance.
 * @returns {DirScanner} - A DirScanner instance.
 */
function make() {
    return {
        scanDirectory,
    };
}

module.exports = {
    isDirScannerError,
    make,
};
