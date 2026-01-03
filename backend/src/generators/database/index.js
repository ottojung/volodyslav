/**
 * Database module for generators.
 * Provides a LevelDB key-value store for storing generated values and event log mirrors.
 */

const path = require('path');
const { makeDatabase } = require('./class');
const { DatabaseInitializationError } = require('./errors');
const { freshnessKey, isFreshness, isDatabaseValue } = require('./types');
const { makeRootDatabase, isRootDatabase } = require('./root_database');
const { makeTypedDatabase, isTypedDatabase } = require('./typed_database');

/** @typedef {import('./types').DatabaseCapabilities} DatabaseCapabilities */
/** @typedef {import('./class').Database} Database */

/**
 * Gets or creates a database instance for the generators module.
 * The database is stored in the Volodyslav data directory.
 *
 * @param {DatabaseCapabilities} capabilities - The capabilities object
 * @returns {Promise<Database>} The database instance
 * @throws {DatabaseInitializationError} If database initialization fails
 */
async function get(capabilities) {
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
        const db = await makeDatabase(databasePath);
        capabilities.logger.logDebug({ databasePath }, 'Database opened');
        return db;
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new DatabaseInitializationError(
            `Failed to open database: ${err.message}`,
            databasePath,
            err
        );
    }
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
    get,
    getRootDatabase,
    freshnessKey,
    isFreshness,
    isDatabaseValue,
    makeRootDatabase,
    isRootDatabase,
    makeTypedDatabase,
    isTypedDatabase,
};
