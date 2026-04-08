/**
 * Root database initialization utilities.
 *
 * Boot sequence (executed by getRootDatabase):
 *
 *  1. Open/create the LevelDB via makeRootDatabase, which:
 *       a. Reads _meta/format; if it does not match FORMAT_MARKER, throws
 *          (satisfies "format mismatch → crash").
 *       b. If _meta/format is absent (truly empty database), writes the
 *          current FORMAT_MARKER and replica pointer.
 *
 *  2. The caller (internalEnsureInitializedWithMigration in lifecycle.js) then
 *     invokes runMigrationUnsafe, which reads x/meta.version and migrates when
 *     the stored version differs from the current application version
 *     (satisfies "version mismatch → migrate").
 *
 * If the live LevelDB directory does not exist yet (first boot or deleted),
 * the caller (internalEnsureInitialized in lifecycle.js) is responsible for
 * detecting the absence and triggering synchronizeNoLock with resetToHostname
 * before calling this function.  That sync path uses an atomic git transaction
 * to populate the LevelDB from the remote rendered snapshot, preserving the
 * correct format marker so the check here works correctly.
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
