
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
    return getEnv("OPENAI_API_KEY");
}

function myRoot() {
    return getEnv("MY_ROOT");
}

function myServerPort() {
    try {
        return parseInt(getEnv("MY_SERVER_PORT"));
    } catch {
        return 29932;
    }
}

module.exports = { openaiAPIKey, myRoot, myServerPort };
