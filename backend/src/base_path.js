const path = require("path");

/**
 * @typedef {object} Capabilities
 * @property {import("./filesystem/reader").FileReader} reader - A file reader instance.
 * @property {import("./filesystem/checker").FileChecker} checker - A file checker instance.
 * @property {import("./environment").Environment} environment - An environment instance.
 */

/** @type {WeakMap<object, string>} */
const cache = new WeakMap();

/**
 * Extracts the path prefix from a raw VOLODYSLAV_BASEURL value.
 * Accepts a full URL (https://example.com/app) or a plain path (/app).
 * Returns empty string for root or invalid values.
 * @param {string} raw
 * @returns {string}
 */
function extractBasePath(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return "";
    }
    try {
        const url = new URL(trimmed);
        return url.pathname.replace(/\/+$/, "");
    } catch {
        const p = trimmed.startsWith("/") ? trimmed : "/" + trimmed;
        return p.replace(/\/+$/, "");
    }
}

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
        return extractBasePath(content);
    } catch {
        return "";
    }
}

/**
 * Gets the base path prefix. Checks the injectable `capabilities.environment.basePath()`
 * first; if it returns a non-empty value, that value is used. Otherwise falls back to
 * reading from the BASE_PATH file. The result is memoized per capabilities object so
 * it is computed at most once per capabilities instance.
 * @param {Capabilities} capabilities
 * @returns {Promise<string>}
 */
async function getBasePath(capabilities) {
    if (cache.has(capabilities)) {
        return /** @type {string} */ (cache.get(capabilities));
    }

    const envBasePath = capabilities.environment.basePath();
    if (envBasePath) {
        const result = extractBasePath(envBasePath);
        cache.set(capabilities, result);
        return result;
    }

    const result = await readBasePathFromFile(capabilities);
    cache.set(capabilities, result);
    return result;
}

module.exports = { getBasePath };
