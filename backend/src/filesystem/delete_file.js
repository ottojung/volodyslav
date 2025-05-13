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

class FileDeleter {
    /** 
     * @type {undefined}
     * @private
     */
    __brand;
}

function makeCapability() {
    return new FileDeleter();
}

/**
 * Deletes a file at the specified path.
 * @param {FileDeleter} _deleter - The file deleter capability.
 * @param {string} filePath - The path to the file to delete.
 * @returns {Promise<void>} - A promise that resolves when the file is deleted.
 */
async function deleteFile(_deleter, filePath) {
    try {
        await fs.unlink(filePath);
    } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            throw new FileNotFoundError(filePath);
        } else {
            throw new FileDeleterError(
                `Failed to delete file: ${filePath}`,
                filePath
            );
        }
    }
}

module.exports = {
    FileDeleterError,
    FileNotFoundError,
    makeCapability,
    deleteFile,
};
