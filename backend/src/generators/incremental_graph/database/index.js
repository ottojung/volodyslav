/**
 * Database module for generators.
 * Provides a LevelDB key-value store for storing generated values and event log mirrors.
 */

const path = require('path');
const { DatabaseInitializationError } = require('./errors');
const { isFreshness, schemaHashToString, stringToSchemaHash, stringToNodeKeyString, nodeNameToString, stringToNodeName, nodeKeyStringToString, schemaPatternToString, stringToSchemaPattern } = require('./types');
const { makeRootDatabase, isRootDatabase } = require('./root_database');
const { makeTypedDatabase, isTypedDatabase } = require('./typed_database');

/** @typedef {import('./types').DatabaseCapabilities} DatabaseCapabilities */

/**
 * Gets or creates a RootDatabase instance for the generators module.
 * The database is stored in the Volodyslav data directory.
 *
 * @param {DatabaseCapabilities} capabilities - The capabilities object
 * @returns {Promise<import('./root_database').RootDatabase>} The root database instance
 * @throws {DatabaseInitializationError} If database initialization fails
 */
async function getRootDatabase(capabilities) {
    const dataDir = capabilities.environment.pathToVolodyslavDataDirectory();
    const databasePath = path.join(dataDir, 'generators-leveldb');

    // Ensure the data directory exists
    try {
        await capabilities.creator.createDirectory(dataDir);
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
        const db = await makeRootDatabase(databasePath);
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
    isFreshness,
    makeRootDatabase,
    isRootDatabase,
    makeTypedDatabase,
    isTypedDatabase,
    schemaHashToString,
    stringToSchemaHash,
    stringToNodeKeyString,
    nodeNameToString,
    stringToNodeName,
    nodeKeyStringToString,
    schemaPatternToString,
    stringToSchemaPattern,
};
