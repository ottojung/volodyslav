/**
 * Database module for generators.
 * Provides a thin libsql interface for storing generated values and event log mirrors.
 */

const { createClient } = require('@libsql/client');
const path = require('path');
const { makeDatabase } = require('./class');
const { ensureTablesExist } = require('./tables');
const { DatabaseInitializationError } = require('./errors');

/** @typedef {import('./types').DatabaseCapabilities} DatabaseCapabilities */
/** @typedef {import('./class').Database} Database */

/**
 * Gets or creates a database instance for the generators module.
 * The database file is stored in the Volodyslav data directory.
 * Ensures all required tables (events, modifiers) exist.
 *
 * @param {DatabaseCapabilities} capabilities - The capabilities object
 * @returns {Promise<Database>} The database instance
 * @throws {DatabaseInitializationError} If database initialization fails
 */
async function get(capabilities) {
    const dataDir = capabilities.environment.pathToVolodyslavDataDirectory();
    const databasePath = path.join(dataDir, 'generators.db');

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
    let client;
    try {
        client = createClient({
            url: `file:${databasePath}`
        });
        capabilities.logger.logInfo({ databasePath }, 'DatabaseOpened');
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new DatabaseInitializationError(
            `Failed to open database: ${err.message}`,
            databasePath,
            err
        );
    }

    // Enable foreign key constraints
    try {
        await client.execute('PRAGMA foreign_keys = ON');
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        client.close();
        throw new DatabaseInitializationError(
            `Failed to enable foreign keys: ${err.message}`,
            databasePath,
            err
        );
    }

    // Ensure tables exist
    try {
        await ensureTablesExist(client, databasePath, capabilities);
    } catch (error) {
        // Close the database before re-throwing
        client.close();
        throw error;
    }

    return makeDatabase(client, databasePath);
}

module.exports = {
    get,
};
