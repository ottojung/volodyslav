const path = require("path");
const { storage, isTryDeserializeError } = require("./config");
const { isFileNotFoundError } = require("./filesystem").checker;

/**
 * @typedef {import('./config/structure').Config} Config
 * @typedef {import('./filesystem/checker').FileChecker} FileChecker
 * @typedef {import('./filesystem/reader').FileReader} FileReader
 * @typedef {import('./filesystem/writer').FileWriter} FileWriter
 * @typedef {import('./filesystem/creator').FileCreator} FileCreator
 * @typedef {import('./logger').Logger} Logger
 * @typedef {import('./environment').Environment} Environment
 */

/**
 * @param {import('./environment').Environment} environment
 * @returns {string}
 */
function pathToConfig(environment) {
    return path.join(environment.workingDirectory(), "config.json");
}

/**
 * @param {{ checker: FileChecker, reader: FileReader, logger: Logger, environment: Environment }} capabilities
 * @returns {Promise<Config | null>}
 */
async function readConfig(capabilities) {
    const filepath = pathToConfig(capabilities.environment);
    const file = await capabilities.checker.instantiate(filepath).catch((error) => {
        if (isFileNotFoundError(error)) {
            return null;
        }
        throw error;
    });

    if (file === null) {
        return null;
    }

    try {
        const result = await storage.readConfig(capabilities, file);
        if (result instanceof Error || isTryDeserializeError(result)) {
            capabilities.logger.logWarning(
                {
                    filepath: file.path,
                    field: "field" in result ? result.field : undefined,
                    expectedType: "expectedType" in result ? result.expectedType : undefined,
                },
                "Found invalid config object in file"
            );
            return null;
        }
        return result;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        capabilities.logger.logError(
            {
                filepath: file.path,
                error: message,
            },
            "Failed to read config.json"
        );
        return null;
    }
}

/**
 * @param {{ writer: FileWriter, creator: FileCreator, checker: FileChecker, logger: Logger, environment: Environment }} capabilities
 * @param {Config} config
 * @returns {Promise<void>}
 */
async function writeConfig(capabilities, config) {
    await storage.writeConfig(
        capabilities,
        pathToConfig(capabilities.environment),
        config
    );
}

module.exports = {
    pathToConfig,
    readConfig,
    writeConfig,
};
