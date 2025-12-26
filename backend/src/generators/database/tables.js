/**
 * Table definitions and initialization for the generators database.
 */

const { TableCreationError } = require('./errors');

/** @typedef {import('sqlite3').Database} SQLiteDatabase */
/** @typedef {import('./types').DatabaseCapabilities} DatabaseCapabilities */

/**
 * SQL schema for the events table.
 * This table mirrors the events from the event log.
 */
const EVENTS_TABLE_SCHEMA = `
    CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY NOT NULL,
        type TEXT NOT NULL,
        input TEXT NOT NULL,
        original TEXT NOT NULL,
        description TEXT NOT NULL,
        date TEXT NOT NULL,
        modifiers TEXT NOT NULL,
        creator TEXT NOT NULL
    )
`;

/**
 * SQL schema for the modifiers table.
 * This table stores modifiers extracted from events.
 */
const MODIFIERS_TABLE_SCHEMA = `
    CREATE TABLE IF NOT EXISTS modifiers (
        event_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (event_id, key),
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    )
`;

/**
 * Ensures all required tables exist in the database.
 * @param {SQLiteDatabase} db - The SQLite database instance
 * @param {string} databasePath - Path to the database file (for error reporting)
 * @param {DatabaseCapabilities} capabilities - The capabilities object
 * @returns {Promise<void>}
 * @throws {TableCreationError} If table creation fails
 */
async function ensureTablesExist(db, databasePath, capabilities) {
    try {
        await runQuery(db, EVENTS_TABLE_SCHEMA);
        capabilities.logger.logInfo({ table: 'events' }, 'DatabaseTableEnsured');
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new TableCreationError(
            `Failed to create events table: ${err.message}`,
            databasePath,
            'events',
            err
        );
    }

    try {
        await runQuery(db, MODIFIERS_TABLE_SCHEMA);
        capabilities.logger.logInfo({ table: 'modifiers' }, 'DatabaseTableEnsured');
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new TableCreationError(
            `Failed to create modifiers table: ${err.message}`,
            databasePath,
            'modifiers',
            err
        );
    }
}

/**
 * Executes a SQL query that doesn't return results (like CREATE TABLE).
 * @param {SQLiteDatabase} db - The SQLite database instance
 * @param {string} query - The SQL query to execute
 * @returns {Promise<void>}
 */
function runQuery(db, query) {
    return new Promise((resolve, reject) => {
        db.run(query, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

module.exports = {
    ensureTablesExist,
    EVENTS_TABLE_SCHEMA,
    MODIFIERS_TABLE_SCHEMA,
};
