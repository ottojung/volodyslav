/**
 * Database module for generators.
 * Provides a thin SQLite interface for storing generated values and event log mirrors.
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { makeDatabase } = require('./class');
const { ensureTablesExist } = require('./tables');
const { DatabaseInitializationError } = require('./errors');

/** @typedef {import('./types').DatabaseCapabilities} DatabaseCapabilities */
/** @typedef {import('./class').DatabaseClass} Database */

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
    const db = await new Promise((resolve, reject) => {
        const database = new sqlite3.Database(databasePath, (err) => {
            if (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                reject(new DatabaseInitializationError(
                    `Failed to open database: ${error.message}`,
                    databasePath,
                    error
                ));
            } else {
                resolve(database);
            }
        });
    });

    capabilities.logger.logInfo({ databasePath }, 'DatabaseOpened');

    // Enable foreign key constraints
    await new Promise((resolve, reject) => {
        db.run('PRAGMA foreign_keys = ON', (/** @type {Error | null} */ err) => {
            if (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                reject(new DatabaseInitializationError(
                    `Failed to enable foreign keys: ${error.message}`,
                    databasePath,
                    error
                ));
            } else {
                resolve(undefined);
            }
        });
    });

    // Ensure tables exist
    try {
        await ensureTablesExist(db, databasePath, capabilities);
    } catch (error) {
        // Close the database before re-throwing
        db.close();
        throw error;
    }

    return makeDatabase(db, databasePath);
}

module.exports = {
    get,
};
