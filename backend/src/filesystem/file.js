/**
 * This module provides a class for representing an existing file and simple introduction rules for it.
 * Note that the file is not guaranteed to exist just because you have an instance of this class.
 * All this class guarantees is that the file was created at some point in the past.
 *
 * This module should not be used outside of the ./filesystem/ directory.
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

class ExistingFileClass {
    /**
     * The path to the file.
     * @type {string}
     */
    path;

    /**
     * This is a value that is never actually assigned.
     * Its purpose is to make `ExistingFile` a nominal type.
     * @private
     * @type {undefined}
     */
    // @ts-ignore
    __brand;

    /**
     * @param {string} path - The path to the file.
     */
    constructor(path) {
        this.path = path;
    }
}

/**
 * @typedef {ExistingFileClass} ExistingFile
 */

/**
 * Creates an empty file at the specified path.
 * @param {string} path - The path to the file to create.
 * @returns {Promise<ExistingFile>} - A promise that resolves when the file is created.
 */
async function makeEmpty(path) {
    await fs.writeFile(path, "");
    return new ExistingFileClass(path);
}

/**
 * Creates an ExistingFile instance from an existing file.
 * @param {string} path - The path to the file to create.
 * @returns {Promise<ExistingFile>} - A promise that resolves when the file is created.
 * @throws {FileCreatorError} - If the file does not exist.
 */
async function fromExisting(path) {
    try {
        await fs.access(path);
        return new ExistingFileClass(path);
    } catch {
        throw new FileCreatorError(`File does not exist: ${path}`, path);
    }
}

/**
 * Creates an empty file at the specified path.
 * @param {ExistingFile} existingFile - The existing file to copy.
 * @param {string} destinationPath - The path to the destination file.
 * @returns {Promise<ExistingFile>} - A promise that resolves when the file is created.
 */
async function makeCopy(existingFile, destinationPath) {
    // Ensure the destination directory exists
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });

    // Copy the file
    await fs.copyFile(existingFile.path, destinationPath);

    return new ExistingFileClass(destinationPath);
}

/**
 * Gets the children of a directory at the specified path.
 * @param {string} dirPath - The path to the directory to scan.
 * @returns {Promise<ExistingFile[]>} - A promise that resolves to an array of ExistingFile objects representing the directory contents.
 */
async function getDirectoryChildren(dirPath) {
    const files = await fs.readdir(dirPath);
    return files.map((file) => {
        return new ExistingFileClass(path.join(dirPath, file));
    });
}

module.exports = {
    fromExisting,
    makeEmpty,
    makeCopy,
    getDirectoryChildren,
    isFileCreatorError,
};
