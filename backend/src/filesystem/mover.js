const fs = require("fs").promises;

class FileMoverError extends Error {
    /**
     * @param {string} message
     * @param {string} sourcePath
     * @param {string} destinationPath
     */
    constructor(message, sourcePath, destinationPath) {
        super(message);
        this.name = "FileMoverError";
        this.sourcePath = sourcePath;
        this.destinationPath = destinationPath;
    }
}

class DestinationExistsError extends FileMoverError {
    /**
     * @param {string} sourcePath
     * @param {string} destinationPath
     * @param {"EEXIST" | "ENOTEMPTY"} code
     */
    constructor(sourcePath, destinationPath, code) {
        super(
            `Cannot move directory from ${sourcePath} to ${destinationPath}: destination already exists`,
            sourcePath,
            destinationPath
        );
        this.name = "DestinationExistsError";
        this.code = code;
    }
}

/**
 * Checks if the error is a FileMoverError.
 * @param {unknown} object
 * @returns {object is FileMoverError}
 */
function isFileMoverError(object) {
    return object instanceof FileMoverError;
}

/**
 * @param {unknown} object
 * @returns {object is DestinationExistsError}
 */
function isDestinationExistsError(object) {
    return object instanceof DestinationExistsError;
}

/**
 * @typedef {object} FileMover
 * @property {typeof moveDirectory} moveDirectory
 */

/**
 * Moves (renames) a directory.
 * @param {string} sourcePath
 * @param {string} destinationPath
 * @returns {Promise<void>}
 */
async function moveDirectory(sourcePath, destinationPath) {
    try {
        await fs.rename(sourcePath, destinationPath);
    } catch (error) {
        if (
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            (error.code === "EEXIST" || error.code === "ENOTEMPTY")
        ) {
            throw new DestinationExistsError(
                sourcePath,
                destinationPath,
                error.code
            );
        }
        throw new FileMoverError(
            `Failed to move directory from ${sourcePath} to ${destinationPath}: ${String(error)}`,
            sourcePath,
            destinationPath
        );
    }
}

/**
 * @returns {FileMover}
 */
function make() {
    return {
        moveDirectory,
    };
}

module.exports = {
    isFileMoverError,
    isDestinationExistsError,
    make,
};
