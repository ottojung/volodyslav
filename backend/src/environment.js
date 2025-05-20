
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
    return parseInt(getEnv("VOLODYSLAV_SERVER_PORT"));
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
 * @typedef {object} Environment
 * @property {() => string} openaiAPIKey - Returns the OpenAI API key
 * @property {() => string} workingDirectory - Returns the working directory
 * @property {() => number} myServerPort - Returns the server port
 * @property {() => string} logLevel - Returns the log level
 * @property {() => string} logFile - Returns the log file path
 * @property {() => string} diaryAudiosDirectory - Returns the diary audio recordings directory
 * @property {() => string} eventLogAssetsDirectory - Returns the event log assets directory
 * @property {() => string} eventLogRepository - Returns the event log repository path
 */

/**
 * Creates an environment capability object.
 * @returns {Environment} - An environment capability object.
 */
function make() {
    return {
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
    openaiAPIKey,
    workingDirectory,
    myServerPort,
    logLevel,
    logFile,
    diaryAudiosDirectory,
    eventLogAssetsDirectory,
    eventLogRepository,
    make,
};
