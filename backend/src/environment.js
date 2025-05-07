
/**
 * Retrieves the value of the specified environment variable or throws if unset.
 * @param {string} key - The name of the environment variable.
 * @returns {string}
 */
function getEnv(key) {
    const ret = process.env[key]
    if (!ret) {
        throw new Error(`Environment variable ${key} must be set.`);
    }
    return ret;
}

function openaiAPIKey() {
    return getEnv("VOLODYSLAV_OPENAI_API_KEY");
}

function resultsDirectory() {
    return getEnv("VOLODYSLAV_RESULTS_DIRECTORY");
}

function myServerPort() {
    return parseInt(getEnv("VOLODYSLAV_SERVER_PORT"));
}

function logLevel() {
    return getEnv("VOLODYSLAV_LOG_LEVEL");
}

function diaryAudiosDirectory() {
    return getEnv("VOLODYSLAV_DIARY_RECORDINGS_DIRECTORY");
}

function eventLogAssetsDirectory() {
    return getEnv("VOLODYSLAV_EVENT_LOG_ASSETS_DIRECTORY");
}

function eventLogDirectory() {
    return getEnv("VOLODYSLAV_EVENT_LOG_DIRECTORY");
}

module.exports = {
    openaiAPIKey,
    resultsDirectory,
    myServerPort,
    logLevel,
    diaryAudiosDirectory,
    eventLogAssetsDirectory,
    eventLogDirectory,
};
