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
     */
    constructor(variableName) {
        const message = `Environment variable $${variableName} must be set.`;
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
    if (!ret) {
        throw new EnvironmentError(key);
    }
    return ret;
}

function openaiAPIKey() {
    return getEnv("VOLODYSLAV_OPENAI_API_KEY");
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

function eventLogRepository() {
    return getEnv("VOLODYSLAV_EVENT_LOG_REPOSITORY");
}

/**
 * Ensures that the environment is initialized by checking all required variables.
 * @param {Environment} environment - The environment object to check.
 * @throws {EnvironmentError} If any required environment variable is not set.
 */
function ensureEnvironmentIsInitialized(environment) {
    environment.openaiAPIKey();
    environment.workingDirectory();
    environment.myServerPort();
    environment.logLevel();
    environment.logFile();
    environment.diaryAudiosDirectory();
    environment.eventLogAssetsDirectory();
    environment.eventLogRepository();
}

/**
 * Creates an environment object with all the necessary environment variables.
 */
function make() {
    return {
        ensureEnvironmentIsInitialized,    
        openaiAPIKey,
        workingDirectory,
        myServerPort,
        logLevel,
        logFile,
        diaryAudiosDirectory,
        eventLogAssetsDirectory,
        eventLogRepository,
    };
}

module.exports = {
    isEnvironmentError,
    make,
};
