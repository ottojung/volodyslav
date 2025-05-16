const fs = require("fs").promises;

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
 */

/**
 * Checks if a file exists and is a regular file.
 * @param {string} filePath - The path to the file to check.
 * @returns {Promise<boolean>} - A promise that resolves with true if the file exists and is a regular file, false otherwise.
 */
async function fileExists(filePath) {
    try {
        const stats = await fs.stat(filePath);
        return stats.isFile();
    } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return false;
        }

        throw new FileCheckerError(
            `Failed to check file existence: ${filePath}`,
            filePath
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
    };
}

module.exports = {
    isFileCheckerError,
    make,
};
