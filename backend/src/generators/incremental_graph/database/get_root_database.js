/**
 * Root database initialization utilities.
 *
 * This module's responsibility is to open (or create) the live LevelDB
 * instance.  `getRootDatabase` ensures the directory exists, then delegates
 * to `makeRootDatabase` which initialises `_meta/current_replica` on first
 * open of a truly empty database.
 *
 * Version migration ("version mismatch → migrate") is handled by the caller
 * (`internalEnsureInitializedWithMigration` in lifecycle.js) via
 * `runMigrationUnsafe` after this function returns.
 *
 * Recovery when the live LevelDB directory is missing (for example, deleted
 * or lost after a previous crash) is handled by the caller
 * (`internalEnsureInitialized` in lifecycle.js): it performs bootstrap via
 * `synchronizeNoLock` before this module opens the database.
 */

const { pathToLiveDatabase } = require('./gitstore');
const { makeRootDatabase } = require('./root_database');

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
    const databasePath = pathToLiveDatabase(capabilities);

    if (await capabilities.checker.directoryExists(databasePath)) {
        capabilities.logger.logInfo({ databasePath }, 'Database directory exists');
    } else {
        capabilities.logger.logInfo({ databasePath }, 'Database directory does not exist, will be created');
    }

    // Ensure the LevelDB directory exists before LevelDB opens.
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
    DatabaseInitializationError,
    isDatabaseInitializationError,
    getRootDatabase,
};
