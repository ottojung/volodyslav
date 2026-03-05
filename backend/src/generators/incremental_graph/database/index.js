/**
 * Database module for generators.
 * Provides a LevelDB key-value store for storing generated values and event log mirrors.
 */

const path = require('path');
const { schemaPatternToString, stringToSchemaPattern, stringToNodeKeyString, nodeNameToString, stringToNodeName, nodeKeyStringToString, versionToString, stringToVersion } = require('./types');
const { makeRootDatabase, isRootDatabase } = require('./root_database');
const { makeTypedDatabase, isTypedDatabase } = require('./typed_database');
const { checkpointDatabase, CHECKPOINT_WORKING_PATH, DATABASE_SUBPATH } = require('./gitstore');

/** @typedef {import('./types').DatabaseCapabilities} DatabaseCapabilities */

/**
 * Thrown when the database cannot be opened or created.
 */
class DatabaseInitializationError extends Error {
    /**
     * @param {string} message
     * @param {string} databasePath
     * @param {Error} [cause]
     */
    constructor(message, databasePath, cause) {
        super(message);
        this.name = 'DatabaseInitializationError';
        this.databasePath = databasePath;
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is DatabaseInitializationError}
 */
function isDatabaseInitializationError(object) {
    return object instanceof DatabaseInitializationError;
}

/**
 * Gets or creates a RootDatabase instance for the generators module.
 * The database is stored in the Volodyslav data directory.
 *
 * @param {DatabaseCapabilities} capabilities - The capabilities object
 * @returns {Promise<import('./root_database').RootDatabase>} The root database instance
 * @throws {DatabaseInitializationError} If database initialization fails
 */
async function getRootDatabase(capabilities) {
    const dataDir = capabilities.environment.workingDirectory();
    const databasePath = path.join(dataDir, CHECKPOINT_WORKING_PATH, DATABASE_SUBPATH);

    if (await capabilities.checker.fileExists(databasePath)) {
        capabilities.logger.logDebug({ databasePath }, 'Database directory exists');
    } else {
        capabilities.logger.logInfo({ databasePath }, 'Database directory does not exist, will be created');
    }

    // Ensure the parent directory (the git working tree) exists before LevelDB opens.
    try {
        await capabilities.creator.createDirectory(databasePath);
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new DatabaseInitializationError(
            `Failed to create data directory: ${err.message}`,
            databasePath,
            err
        );
    }

    // Open or create the database
    try {
        const db = await makeRootDatabase(capabilities, databasePath);
        capabilities.logger.logDebug({ databasePath }, 'Root database opened');
        return db;
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new DatabaseInitializationError(
            `Failed to open root database: ${err.message}`,
            databasePath,
            err
        );
    }
}

module.exports = {
    getRootDatabase,
    makeRootDatabase,
    isRootDatabase,
    isDatabaseInitializationError,
    makeTypedDatabase,
    isTypedDatabase,
    checkpointDatabase,
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    stringToNodeKeyString,
    nodeNameToString,
    stringToNodeName,
    nodeKeyStringToString,
    schemaPatternToString,
    stringToSchemaPattern,
    versionToString,
    stringToVersion,
};
