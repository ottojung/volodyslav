/**
 * This module provides a class for representing an existing file and simple introduction rules for it.
 * Note that the file is not guaranteed to exist just because you have an instance of this class.
 * All this class guarantees is that the file was created at some point in the past.
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
        this.name = "FileCreatorError";
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
    __brand;

    /**
     * @param {string} path - The path to the file.
     */
    constructor(path) {
        this.path = path;
        if (this.__brand !== undefined) {
            throw new Error();
        }
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
 * @typedef {import('./checker').Explicit} Explicit
 * @typedef {import('./dirscanner').DirectoryMember} DirectoryMember
 * @typedef {Explicit|DirectoryMember} FileExistenceProof
 */

/**
 * Creates an ExistingFile instance from an existing file.
 * @param {string} path - The path to the file to create.
 * @param {FileExistenceProof} proof - A proof that the file exists.
 * @returns {ExistingFile} - A promise that resolves when the file is created.
 * @throws {FileCreatorError} - If the file does not exist.
 */
function fromExisting(path, proof) {
    if (!proof) {
        throw new FileCreatorError(`No proof provided for file: ${path}`, path);
    }

    if (proof.path !== path) {
        throw new Error(
            `Proof path does not match: expected ${path}, got ${proof.path}`
        );
    }

    try {
        return new ExistingFileClass(path);
    } catch {
        throw new FileCreatorError(`File does not exist: ${path}`, path);
    }
}

/**
 * Copies an existing file to the destination path.
 * The target directory is created if it does not exist.
 *
 * @param {ExistingFile} existingFile - The file to copy from.
 * @param {string} destinationPath - The path of the copied file.
 * @returns {Promise<ExistingFile>} - A promise that resolves with the new file instance.
 */
async function makeCopy(existingFile, destinationPath) {
    // Ensure the destination directory exists
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });

    // Copy the file
    await fs.copyFile(existingFile.path, destinationPath);

    return new ExistingFileClass(destinationPath);    
}

module.exports = {
    fromExisting,
    makeEmpty,
    makeCopy,
    isFileCreatorError,
};
