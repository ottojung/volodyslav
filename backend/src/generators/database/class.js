/**
 * Database class - thin wrapper over SQLite.
 */

const sqlite3 = require("sqlite3");
const { DatabaseInitializationError, DatabaseQueryError } = require("./errors");

/** @typedef {import('./types').DatabaseCapabilities} DatabaseCapabilities */

/**
 * A thin wrapper class around SQLite database.
 */
class DatabaseClass {
    /**
     * @private
     * @type {undefined}
     */
    __brand = undefined;

    /**
     * Path to the database file
     * @private
     * @type {string}
     */
    databasePath;

    /**
     * SQLite database connection
     * @private
     * @type {sqlite3.Database}
     */
    db;

    /**
     * @constructor
     * Initializes the database connection.
     * @param {string} databasePath - Path to the SQLite database file.
     * @param {sqlite3.Database} db - The SQLite database connection.
     */
    constructor(databasePath, db) {
        if (this.__brand !== undefined) {
            throw new Error("Database is a nominal type");
        }
        this.databasePath = databasePath;
        this.db = db;
    }

    /**
     * Executes a SQL query that doesn't return rows (CREATE, INSERT, UPDATE, DELETE).
     * @param {string} sql - The SQL query to execute.
     * @param {Array<any>} [params] - Optional parameters for the query.
     * @returns {Promise<void>}
     */
    async run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, (err) => {
                if (err) {
                    reject(
                        new DatabaseQueryError(
                            `Failed to execute query: ${err.message}`,
                            this.databasePath,
                            sql,
                            err
                        )
                    );
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Executes a SQL query and returns all matching rows.
     * @param {string} sql - The SQL query to execute.
     * @param {Array<any>} [params] - Optional parameters for the query.
     * @returns {Promise<Array<any>>}
     */
    async all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(
                        new DatabaseQueryError(
                            `Failed to execute query: ${err.message}`,
                            this.databasePath,
                            sql,
                            err
                        )
                    );
                } else {
                    resolve(rows);
                }
            });
        });
    }

    /**
     * Executes a SQL query and returns the first matching row.
     * @param {string} sql - The SQL query to execute.
     * @param {Array<any>} [params] - Optional parameters for the query.
     * @returns {Promise<any|undefined>}
     */
    async get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    reject(
                        new DatabaseQueryError(
                            `Failed to execute query: ${err.message}`,
                            this.databasePath,
                            sql,
                            err
                        )
                    );
                } else {
                    resolve(row);
                }
            });
        });
    }

    /**
     * Closes the database connection.
     * @returns {Promise<void>}
     */
    async close() {
        return new Promise((resolve, reject) => {
            this.db.close((err) => {
                if (err) {
                    reject(
                        new DatabaseQueryError(
                            `Failed to close database: ${err.message}`,
                            this.databasePath,
                            "CLOSE",
                            err
                        )
                    );
                } else {
                    resolve();
                }
            });
        });
    }
}

/** @typedef {DatabaseClass} Database */

/**
 * Ensures the mirror tables exist in the database.
 * @param {Database} database
 * @returns {Promise<void>}
 */
async function ensureMirrorTablesExist(database) {
    // Create events table
    await database.run(`
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            input TEXT NOT NULL,
            original TEXT NOT NULL
        )
    `);

    // Create modifiers table
    await database.run(`
        CREATE TABLE IF NOT EXISTS modifiers (
            id INTEGER PRIMARY KEY AUTOINCREMENT
        )
    `);
}

/**
 * Creates a new Database instance and initializes mirror tables.
 * @param {DatabaseCapabilities} capabilities
 * @param {string} databasePath
 * @returns {Promise<Database>}
 */
async function make(capabilities, databasePath) {
    // Ensure the directory exists
    const path = require("path");
    const dirPath = path.dirname(databasePath);
    
    try {
        // Check if directory exists, if not create it
        const dirExists = await capabilities.checker.fileExists(dirPath);
        if (!dirExists) {
            await capabilities.creator.createDirectory(dirPath);
        }
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new DatabaseInitializationError(
            `Failed to create database directory: ${err.message}`,
            databasePath,
            err
        );
    }

    // Open database connection
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(databasePath, async (err) => {
            if (err) {
                reject(
                    new DatabaseInitializationError(
                        `Failed to open database: ${err.message}`,
                        databasePath,
                        err
                    )
                );
            } else {
                try {
                    const database = new DatabaseClass(databasePath, db);
                    await ensureMirrorTablesExist(database);
                    resolve(database);
                } catch (error) {
                    const dbErr = error instanceof Error ? error : new Error(String(error));
                    reject(
                        new DatabaseInitializationError(
                            `Failed to initialize database tables: ${dbErr.message}`,
                            databasePath,
                            dbErr
                        )
                    );
                }
            }
        });
    });
}

/**
 * Type guard for Database.
 * @param {unknown} object
 * @returns {object is Database}
 */
function isDatabase(object) {
    return object instanceof DatabaseClass;
}

module.exports = {
    make,
    isDatabase,
};
