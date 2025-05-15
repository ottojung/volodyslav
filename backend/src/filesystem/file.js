/**
 *
 */

const fs = require("fs").promises;

class ExistingFileClass {

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
