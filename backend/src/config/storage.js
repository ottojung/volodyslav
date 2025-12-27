/**
 * Implements storage for config.json files with type-safe handling.
 *
 * This module provides utilities to read and write configuration files
 * in a structured way, following patterns established by the event log storage.
 */

const {
    serialize,
    tryDeserialize,
    makeInvalidStructureError,
} = require("./structure");
const { readObjects } = require("../json_stream_file");
const filesystem = require("../filesystem");
const { fromExisting } = filesystem.file;

/** @typedef {import('../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../logger').Logger} Logger */

/**
 * @typedef {object} Capabilities
 * @property {FileReader} reader - A file reader instance
 * @property {FileWriter} writer - A file writer instance
 * @property {import('../filesystem/creator').FileCreator} creator - A file creator instance
 * @property {import('../filesystem/checker').FileChecker} checker - A file checker instance
 * @property {Logger} logger - A logger instance
 */

/**
 * Minimal capabilities needed for reading config files
 * @typedef {object} ConfigReadCapabilities
 * @property {FileReader} reader - A file reader instance
 * @property {Logger} logger - A logger instance
 */

/**
 * Minimal capabilities needed for writing config files
 * @typedef {object} ConfigWriteCapabilities
 * @property {FileWriter} writer - A file writer instance
 * @property {import('../filesystem/creator').FileCreator} creator - A file creator instance
 * @property {import('../filesystem/checker').FileChecker} checker - A file checker instance
 * @property {Logger} logger - A logger instance
 */

/**
 * Reads and deserializes a config.json file
 * @param {ConfigReadCapabilities} capabilities - The minimal capabilities needed for reading
 * @param {import("../filesystem/file").ExistingFile} file - The config.json file to read
 * @returns {Promise<import('./structure').Config | Error>} The parsed config or error object
*/
async function readConfig(capabilities, file) {
    const objects = await readObjects(capabilities, file);

    if (objects.length === 0) {
        return makeInvalidStructureError("Config file is empty", []);
    }

    if (objects.length > 1) {
        // This is not necessarily an error, just use the first object
        // Higher-level code can decide whether to log this or not
    }

    // Try to deserialize the config object and return the result (either Config or error)
    return tryDeserialize(objects[0]);
}

/**
 * Serializes and writes a config object to a JSON file
 * @param {ConfigWriteCapabilities} capabilities - The minimal capabilities needed for writing
 * @param {string} filepath - Path to write the config.json file
 * @param {import('./structure').Config} configObj - The config object to write
 * @returns {Promise<void>}
 */
async function writeConfig(capabilities, filepath, configObj) {
    try {
        const serialized = serialize(configObj);
        const configString = JSON.stringify(serialized, null, "\t");

        // Create file first if it doesn't exist, then get ExistingFile instance with proof
        await capabilities.creator.createFile(filepath);
        const proof = await capabilities.checker.fileExists(filepath);
        if (!proof) {
            throw new Error(`Failed to create config file: ${filepath}`);
        }
        const file = fromExisting(filepath, proof);
        await capabilities.writer.writeFile(file, configString + "\n");

        capabilities.logger.logInfo(
            {
                filepath,
                shortcutCount: configObj.shortcuts.length,
            },
            "Config file written successfully"
        );
    } catch (error) {
        const errorMessage =
            error instanceof Error ? error.message : String(error);
        capabilities.logger.logError(
            {
                filepath,
                error: errorMessage,
            },
            "Failed to write config file"
        );
        throw error;
    }
}

/**
 * Creates a default config object with empty values
 * @returns {import('./structure').Config} A default config object
 */
function createDefaultConfig() {
    return {
        help: "Welcome to Volodyslav's configuration. Add shortcuts below to customize text replacements.",
        shortcuts: [],
    };
}

/**
 * Adds a shortcut to a config object (immutable)
 * @param {import('./structure').Config} configObj - The existing config
 * @param {import('./structure').Shortcut} shortcut - The shortcut to add
 * @returns {import('./structure').Config} New config object with the added shortcut
 */
function addShortcut(configObj, shortcut) {
    return {
        ...configObj,
        shortcuts: [...configObj.shortcuts, shortcut],
    };
}

/**
 * Removes a shortcut from a config object by pattern (immutable)
 * @param {import('./structure').Config} configObj - The existing config
 * @param {string} pattern - The pattern of the shortcut to remove
 * @returns {import('./structure').Config} New config object without the matching shortcut
 */
function removeShortcut(configObj, pattern) {
    return {
        ...configObj,
        shortcuts: configObj.shortcuts.filter((s) => s.pattern !== pattern),
    };
}

/**
 * Finds a shortcut by pattern
 * @param {import('./structure').Config} configObj - The config to search
 * @param {string} pattern - The pattern to find
 * @returns {import('./structure').Shortcut | null} The matching shortcut or null
 */
function findShortcut(configObj, pattern) {
    return configObj.shortcuts.find((s) => s.pattern === pattern) || null;
}

module.exports = {
    readConfig,
    writeConfig,
    createDefaultConfig,
    addShortcut,
    removeShortcut,
    findShortcut,
};
