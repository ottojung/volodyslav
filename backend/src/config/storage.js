/**
 * Implements storage for config.json files with type-safe handling.
 *
 * This module provides utilities to read and write configuration files
 * in a structured way, following patterns established by the event log storage.
 */

const config = require("./index");
const { readObjects } = require("../json_stream_file");
const { fromExisting } = require("../filesystem/file");

/** @typedef {import('../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../logger').Logger} Logger */

/**
 * @typedef {object} Capabilities
 * @property {FileReader} reader - A file reader instance
 * @property {FileWriter} writer - A file writer instance
 * @property {import('../filesystem/creator').FileCreator} creator - A file creator instance
 * @property {Logger} logger - A logger instance
 */

/**
 * Reads and deserializes a config.json file
 * @param {Capabilities} capabilities - The capabilities object
 * @param {string} filepath - Path to the config.json file to read
 * @returns {Promise<import('./structure').Config | null>} The parsed config or null if invalid/missing
 */
async function readConfig(capabilities, filepath) {
    try {
        const objects = await readObjects(capabilities, filepath);

        if (objects.length === 0) {
            capabilities.logger.logWarning(
                { filepath },
                "Config file is empty"
            );
            return null;
        }

        if (objects.length > 1) {
            capabilities.logger.logWarning(
                { filepath, objectCount: objects.length },
                "Config file contains multiple objects, using first one"
            );
        }

        const configObj = config.tryDeserialize(objects[0]);
        if (configObj === null) {
            capabilities.logger.logWarning(
                { filepath, invalidObject: objects[0] },
                "Found invalid config object in file"
            );
            return null;
        }

        return configObj;
    } catch (error) {
        capabilities.logger.logWarning(
            {
                filepath,
                error: error instanceof Error ? error.message : String(error),
            },
            "Failed to read config file"
        );
        return null;
    }
}

/**
 * Serializes and writes a config object to a JSON file
 * @param {Capabilities} capabilities - The capabilities object
 * @param {string} filepath - Path to write the config.json file
 * @param {import('./structure').Config} configObj - The config object to write
 * @returns {Promise<void>}
 */
async function writeConfig(capabilities, filepath, configObj) {
    try {
        const serialized = config.serialize(configObj);
        const configString = JSON.stringify(serialized, null, "\t");

        // Create file first if it doesn't exist, then get ExistingFile instance
        await capabilities.creator.createFile(filepath);
        const file = await fromExisting(filepath);
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
