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
const { makeEmpty } = require("./file");
const { resultsDirectory } = require("../environment");

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

/**
 * @typedef {import('./file').ExistingFile} ExistingFile
 */

/**
 * @typedef {object} FileCreator
 * @property {typeof createFile} createFile
 * @property {typeof createDirectory} createDirectory
 * @property {typeof createTemporaryDirectory} createTemporaryDirectory
 */

/**
 * Creates a file at the specified path.
 * @param {string} filePath - The path to the file to create.
 * @returns {Promise<ExistingFile>} - A promise that resolves when the file is created.
 */
async function createFile(filePath) {
    try {
        // Ensure the directory exists
        await createDirectory(path.dirname(filePath));
        return await makeEmpty(filePath);
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

/**
 * Creates a temporary directory in the system's temporary folder.
 * @returns {Promise<string>} - A promise that resolves with the path to the created temporary directory.
 */
async function createTemporaryDirectory() {
    const tmpDir = resultsDirectory();
    const uniquePrefix = path.join(tmpDir, "tmp-");
    try {
        const createdTmpDirPath = await fs.mkdtemp(uniquePrefix);
        return createdTmpDirPath;
    } catch (err) {
        throw new FileCreatorError(
            `Failed to create temporary directory with prefix: ${uniquePrefix}`,
            uniquePrefix // Using uniquePrefix as filePath for the error
        );
    }
}

function make() {
    return {
        createFile,
        createDirectory,
        createTemporaryDirectory,
    };
}

module.exports = {
    isFileCreatorError,
    make,
};
