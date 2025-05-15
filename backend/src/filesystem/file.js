/**
 * This module provides a class for representing an existing file and simple introduction rules for it.
 * Note that the file is not guaranteed to exist just because you have an instance of this class.
 * All this class guarantees is that the file was created at some point in the past.
 */

const fs = require("fs").promises;

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

module.exports = {
    makeEmpty,
};
