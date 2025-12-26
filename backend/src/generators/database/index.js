const { make: makeDatabase } = require("./class");
const path = require("path");

/** @typedef {import('./types').DatabaseCapabilities} DatabaseCapabilities */
/** @typedef {import('./class').Database} Database */

/**
 * Gets a database instance for the generators.
 * The database is stored in the working directory under "generators.db".
 * 
 * @param {DatabaseCapabilities} capabilities - The capabilities object.
 * @returns {Promise<Database>} The database instance.
 */
async function get(capabilities) {
    const workingDir = capabilities.environment.workingDirectory();
    const databasePath = path.join(workingDir, "generators.db");
    
    return await makeDatabase(capabilities, databasePath);
}

module.exports = {
    get,
};
