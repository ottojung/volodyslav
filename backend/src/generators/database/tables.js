/**
 * Table definitions and initialization for the generators database.
 */

const { TableCreationError } = require('./errors');

/** @typedef {import('@libsql/client').Client} LibsqlClient */
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
 * @param {LibsqlClient} client - The libsql client instance
 * @param {string} databasePath - Path to the database file (for error reporting)
 * @param {DatabaseCapabilities} capabilities - The capabilities object
 * @returns {Promise<void>}
 * @throws {TableCreationError} If table creation fails
 */
async function ensureTablesExist(client, databasePath, capabilities) {
    try {
        await client.execute(EVENTS_TABLE_SCHEMA);
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
        await client.execute(MODIFIERS_TABLE_SCHEMA);
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

module.exports = {
    ensureTablesExist,
    EVENTS_TABLE_SCHEMA,
    MODIFIERS_TABLE_SCHEMA,
};
