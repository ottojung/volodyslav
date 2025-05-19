
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

function eventLogDirectory() {
    return getEnv("VOLODYSLAV_EVENT_LOG_DIRECTORY");
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
    eventLogDirectory,
};
