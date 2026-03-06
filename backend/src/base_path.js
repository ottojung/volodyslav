const path = require("path");

/**
 * @typedef {object} Capabilities
 * @property {import("./filesystem/reader").FileReader} reader - A file reader instance.
 * @property {import("./filesystem/checker").FileChecker} checker - A file checker instance.
 */

/** @type {string | undefined} */
let cachedBasePath;

/**
 * Reads the base path prefix from the BASE_PATH file located alongside the
 * VERSION file. Returns an empty string if the file does not exist (development).
 * @param {Capabilities} capabilities
 * @returns {Promise<string>}
 */
async function readBasePathFromFile(capabilities) {
    const basePathFilePath = path.join(__dirname, "..", "..", "BASE_PATH");
    try {
        const file = await capabilities.checker.instantiate(basePathFilePath);
        const content = await capabilities.reader.readFileAsText(file.path);
        return content.trim();
    } catch {
        return "";
    }
}

/**
 * Gets the base path prefix. Reads from the BASE_PATH file if present,
 * otherwise returns an empty string (root path). Memoized after the first call.
 * @param {Capabilities} capabilities
 * @returns {Promise<string>}
 */
async function getBasePath(capabilities) {
    if (cachedBasePath === undefined) {
        cachedBasePath = await readBasePathFromFile(capabilities);
    }
    return cachedBasePath;
}

module.exports = { getBasePath };
