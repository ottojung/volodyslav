const { isValidHostname } = require("./hostname");

/**
 * This module handles environment variable retrieval and validation.
 */

/**
 * @typedef {ReturnType<make>} Environment
 */

class EnvironmentError extends Error {
    /**
     * Custom error class for environment variable errors.
     * @param {string} variableName - The name of the environment variable.
     * @param {string} [reason]
     */
    constructor(variableName, reason = "must be set.") {
        const message = `Environment variable $${variableName} ${reason}`;
        super(message);
        this.variableName = variableName;
    }
}

/**
 * @param {unknown} object
 * @returns {object is EnvironmentError}
 */
function isEnvironmentError(object) {
    return object instanceof EnvironmentError;
}

/**
 * Retrieves the value of the specified environment variable or throws if unset.
 * @param {string} key - The name of the environment variable.
 * @returns {string}
 */
function getEnv(key) {
    const ret = process.env[key];
    if (ret === undefined) {
        throw new EnvironmentError(key);
    }
    return ret;
}

function openaiAPIKey() {
    return getEnv("VOLODYSLAV_OPENAI_API_KEY");
}

function geminiApiKey() {
    return getEnv("VOLODYSLAV_GEMINI_API_KEY");
}

function workingDirectory() {
    return getEnv("VOLODYSLAV_WORKING_DIRECTORY");
}

function myServerPort() {
    const raw = getEnv("VOLODYSLAV_SERVER_PORT");
    if (!/^\d+$/.test(raw)) {
        throw new EnvironmentError("VOLODYSLAV_SERVER_PORT");
    }
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new EnvironmentError("VOLODYSLAV_SERVER_PORT");
    }
    return port;
}

function logLevel() {
    return getEnv("VOLODYSLAV_LOG_LEVEL");
}

function logFile() {
    return getEnv("VOLODYSLAV_LOG_FILE");
}

function diaryAudiosDirectory() {
    return getEnv("VOLODYSLAV_DIARY_RECORDINGS_DIRECTORY");
}

function eventLogAssetsDirectory() {
    return getEnv("VOLODYSLAV_EVENT_LOG_ASSETS_DIRECTORY");
}

function generatorsRepository() {
    return getEnv("VOLODYSLAV_GENERATORS_REPOSITORY");
}

function eventLogAssetsRepository() {
    return getEnv("VOLODYSLAV_EVENT_LOG_ASSETS_REPOSITORY");
}

function hostname() {
    const value = getEnv("VOLODYSLAV_HOSTNAME");
    if (!isValidHostname(value)) {
        throw new EnvironmentError(
            "VOLODYSLAV_HOSTNAME",
            "must match [0-9a-zA-Z_-]+."
        );
    }
    return value;
}

/**
 * Ensures that the environment is initialized by checking all required variables.
 * @param {Environment} environment - The environment object to check.
 * @throws {EnvironmentError} If any required environment variable is not set.
 */
function ensureEnvironmentIsInitialized(environment) {
    environment.openaiAPIKey();
    environment.geminiApiKey();
    environment.workingDirectory();
    environment.myServerPort();
    environment.logLevel();
    environment.logFile();
    environment.diaryAudiosDirectory();
    environment.eventLogAssetsDirectory();
    environment.generatorsRepository();
    environment.eventLogAssetsRepository();
    environment.hostname();
}

/**
 * Creates an environment object with all the necessary environment variables.
 */
function make() {
    return {
        ensureEnvironmentIsInitialized,    
        openaiAPIKey,
        geminiApiKey,
        workingDirectory,
        myServerPort,
        logLevel,
        logFile,
        diaryAudiosDirectory,
        eventLogAssetsDirectory,
        generatorsRepository,
        eventLogAssetsRepository,
        hostname,
    };
}

module.exports = {
    isEnvironmentError,
    make,
};
