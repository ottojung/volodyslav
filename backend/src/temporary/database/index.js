/**
 * TemporaryDatabase module.
 *
 * Wraps a LevelDB instance and exposes a typed get/put/del/batch API
 * for short-lived request data (uploaded blobs and done markers).
 *
 * Inspired by generators/incremental_graph/database/root_database.js.
 */

const path = require("path");
const { stringToTempKey, tempKeyToString } = require("./types");

/** @typedef {import('./types').TempKey} TempKey */
/** @typedef {import('./types').TempEntry} TempEntry */
/** @typedef {import('./types').DatabaseCapabilities} DatabaseCapabilities */

/**
 * Sub-path within workingDirectory() where the database lives.
 */
const TEMPORARY_DB_SUBPATH = "temporary-leveldb";

/**
 * Returns the absolute path to the temporary LevelDB directory.
 * @param {DatabaseCapabilities} capabilities
 * @returns {string}
 */
function pathToTemporaryDatabase(capabilities) {
    return path.join(capabilities.environment.workingDirectory(), TEMPORARY_DB_SUBPATH);
}

// ---------------------------------------------------------------------------
// TemporaryDatabaseClass
// ---------------------------------------------------------------------------

class TemporaryDatabaseClass {
    /**
     * The underlying LevelDB instance (JSON value encoding).
     * @private
     * @type {import('level').Level<string, TempEntry>}
     */
    _db;

    /**
     * @param {import('level').Level<string, TempEntry>} db
     */
    constructor(db) {
        this._db = db;
    }

    /**
     * Retrieve a value by key.
     * Returns `undefined` when the key does not exist.
     * @param {TempKey} key
     * @returns {Promise<TempEntry | undefined>}
     */
    async get(key) {
        return this._db.get(tempKeyToString(key));
    }

    /**
     * Store a value atomically.
     * @param {TempKey} key
     * @param {TempEntry} value
     * @returns {Promise<void>}
     */
    async put(key, value) {
        await this._db.put(tempKeyToString(key), value);
    }

    /**
     * Delete a key.  No-op if the key does not exist.
     * @param {TempKey} key
     * @returns {Promise<void>}
     */
    async del(key) {
        await this._db.del(tempKeyToString(key));
    }

    /**
     * Apply a batch of put/del operations atomically.
     * @param {Array<{type: 'put', key: TempKey, value: TempEntry} | {type: 'del', key: TempKey}>} operations
     * @returns {Promise<void>}
     */
    async batch(operations) {
        if (operations.length === 0) {
            return;
        }
        const raw = operations.map((op) => {
            if (op.type === "put") {
                return { type: op.type, key: tempKeyToString(op.key), value: op.value };
            }
            return { type: op.type, key: tempKeyToString(op.key) };
        });
        await this._db.batch(raw);
    }

    /**
     * Close the underlying LevelDB connection.
     * @returns {Promise<void>}
     */
    async close() {
        await this._db.close();
    }

    /**
     * List all keys that start with the given string prefix.
     * Returns an empty array if no keys match.
     * @param {string} prefix
     * @returns {Promise<TempKey[]>}
     */
    async listKeysByPrefix(prefix) {
        const keys = [];
        for await (const key of this._db.keys({ gte: prefix, lte: prefix + '\uffff' })) {
            keys.push(stringToTempKey(key));
        }
        return keys;
    }

    /**
     * Delete all keys that start with the given string prefix atomically.
     * No-op if no keys match.
     * @param {string} prefix
     * @returns {Promise<void>}
     */
    async deleteKeysByPrefix(prefix) {
        const keys = [];
        for await (const key of this._db.keys({ gte: prefix, lte: prefix + '\uffff' })) {
            keys.push(key);
        }
        if (keys.length === 0) {
            return;
        }
        /** @type {Array<{type: 'del', key: string}>} */
        const ops = keys.map((key) => ({ type: 'del', key }));
        await this._db.batch(ops);
    }
}

/** @typedef {TemporaryDatabaseClass} TemporaryDatabase */

/**
 * Type guard for TemporaryDatabase.
 * @param {unknown} object
 * @returns {object is TemporaryDatabaseClass}
 */
function isTemporaryDatabase(object) {
    return object instanceof TemporaryDatabaseClass;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class TemporaryDatabaseInitializationError extends Error {
    /**
     * @param {string} message
     * @param {string} databasePath
     * @param {Error} [cause]
     */
    constructor(message, databasePath, cause) {
        super(message);
        this.name = "TemporaryDatabaseInitializationError";
        this.databasePath = databasePath;
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is TemporaryDatabaseInitializationError}
 */
function isTemporaryDatabaseInitializationError(object) {
    return object instanceof TemporaryDatabaseInitializationError;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Open (or create) the temporary LevelDB database.
 * The database directory is created automatically if it does not exist.
 *
 * @param {DatabaseCapabilities} capabilities
 * @returns {Promise<TemporaryDatabaseClass>}
 * @throws {TemporaryDatabaseInitializationError}
 */
async function getTemporaryDatabase(capabilities) {
    const databasePath = pathToTemporaryDatabase(capabilities);

    try {
        await capabilities.creator.createDirectory(databasePath);
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new TemporaryDatabaseInitializationError(
            `Failed to create temporary database directory: ${err.message}`,
            databasePath,
            err
        );
    }

    /** @type {import('level').Level<string, TempEntry>} */
    const db = capabilities.levelDatabase.initialize(databasePath);

    try {
        await db.open();
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new TemporaryDatabaseInitializationError(
            `Failed to open temporary database: ${err.message}`,
            databasePath,
            err
        );
    }

    capabilities.logger.logDebug({ databasePath }, "Temporary database opened");
    return new TemporaryDatabaseClass(db);
}

module.exports = {
    getTemporaryDatabase,
    isTemporaryDatabase,
    isTemporaryDatabaseInitializationError,
    TEMPORARY_DB_SUBPATH,
    pathToTemporaryDatabase,
    stringToTempKey,
    tempKeyToString,
};
