/**
 * Temporary storage module.
 *
 * Provides a high-level, request-scoped interface for storing short-lived
 * binary objects (e.g. uploaded files) and request-completion markers.
 *
 * The underlying storage is a LevelDB instance opened lazily on first use.
 * All write operations are atomic.
 *
 * Usage:
 *   // capabilities.temporary is created via makeTemporary(() => capabilities)
 *   await capabilities.temporary.storeBlob(reqId, 'audio.weba', buffer);
 *   const buf = await capabilities.temporary.getBlob(reqId, 'audio.weba');
 *   await capabilities.temporary.deleteBlob(reqId, 'audio.weba');
 *   await capabilities.temporary.markDone(reqId);
 *   const finished = await capabilities.temporary.isDone(reqId);
 */

const path = require("path");
const { getTemporaryDatabase, stringToTempKey } = require("./database");

/** @typedef {import('./database').TemporaryDatabase} TemporaryDatabase */
/** @typedef {import('../request_identifier').RequestIdentifier} RequestIdentifier */
/** @typedef {import('./database/types').DatabaseCapabilities} DatabaseCapabilities */

// ---------------------------------------------------------------------------
// Filename sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a filename to prevent key-space abuse and path traversal when the
 * same name is later used to write to the filesystem.
 * Strips any leading directory components and rejects empty / dot names.
 *
 * @param {string} filename
 * @returns {string}
 */
function sanitizeFilename(filename) {
    const base = path.basename(filename);
    if (base === "" || base === "." || base === "..") {
        throw new Error(`Invalid filename for temporary storage: "${filename}"`);
    }
    return base;
}

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

/**
 * Build the database key for a stored blob.
 * The filename is sanitized via `sanitizeFilename` so that callers cannot
 * create surprising key hierarchies or later trigger path traversal when the
 * same name is used to write to disk.
 * @param {RequestIdentifier} reqId
 * @param {string} filename
 * @returns {import('./database/types').TempKey}
 */
function blobKey(reqId, filename) {
    const safe = sanitizeFilename(filename);
    return stringToTempKey(`blob/${reqId.identifier}/${safe}`);
}

/**
 * Build the database key for a done marker.
 * @param {RequestIdentifier} reqId
 * @returns {import('./database/types').TempKey}
 */
function doneKey(reqId) {
    return stringToTempKey(`done/${reqId.identifier}`);
}

// ---------------------------------------------------------------------------
// Low-level interface (takes an explicit TemporaryDatabase)
// ---------------------------------------------------------------------------

/**
 * Store a binary blob atomically in the temporary database.
 * The buffer is base64-encoded and stored as a JSON value.
 *
 * @param {TemporaryDatabase} database
 * @param {RequestIdentifier} reqId
 * @param {string} filename
 * @param {Buffer} data
 * @returns {Promise<void>}
 */
async function storeBlob(database, reqId, filename, data) {
    await database.put(blobKey(reqId, filename), {
        type: "blob",
        data: data.toString("base64"),
    });
}

/**
 * Retrieve a previously stored binary blob.
 * Returns `null` if the key does not exist.
 *
 * @param {TemporaryDatabase} database
 * @param {RequestIdentifier} reqId
 * @param {string} filename
 * @returns {Promise<Buffer | null>}
 */
async function getBlob(database, reqId, filename) {
    const entry = await database.get(blobKey(reqId, filename));
    if (entry === undefined || entry.type !== "blob") {
        return null;
    }
    return Buffer.from(entry.data, "base64");
}

/**
 * Delete a stored blob.  No-op if the key does not exist.
 *
 * @param {TemporaryDatabase} database
 * @param {RequestIdentifier} reqId
 * @param {string} filename
 * @returns {Promise<void>}
 */
async function deleteBlob(database, reqId, filename) {
    await database.del(blobKey(reqId, filename));
}

/**
 * Atomically mark a request as done.
 *
 * @param {TemporaryDatabase} database
 * @param {RequestIdentifier} reqId
 * @returns {Promise<void>}
 */
async function markDone(database, reqId) {
    await database.put(doneKey(reqId), { type: "done" });
}

/**
 * Check whether a request has been marked done.
 *
 * @param {TemporaryDatabase} database
 * @param {RequestIdentifier} reqId
 * @returns {Promise<boolean>}
 */
async function isDone(database, reqId) {
    const entry = await database.get(doneKey(reqId));
    return entry !== undefined && entry.type === "done";
}

/**
 * Atomically store multiple blobs and mark the request as done in a single
 * LevelDB batch write.  Either all writes succeed or none of them do.
 *
 * @param {TemporaryDatabase} database
 * @param {RequestIdentifier} reqId
 * @param {Array<{filename: string, data: Buffer}>} blobs
 * @returns {Promise<void>}
 */
async function storeBlobsAndMarkDone(database, reqId, blobs) {
    /** @type {Array<{type: 'put', key: import('./database/types').TempKey, value: import('./database/types').TempEntry}>} */
    const operations = [];
    for (const { filename, data } of blobs) {
        operations.push({
            type: "put",
            key: blobKey(reqId, filename),
            value: { type: "blob", data: data.toString("base64") },
        });
    }
    operations.push({
        type: "put",
        key: doneKey(reqId),
        value: { type: "done" },
    });
    await database.batch(operations);
}

// ---------------------------------------------------------------------------
// Temporary capability class (lazy database initialisation)
// ---------------------------------------------------------------------------

class TemporaryClass {
    /**
     * @private
     * @type {() => DatabaseCapabilities}
     */
    _getCapabilities;

    /**
     * Stores the initialization promise so concurrent callers share a single
     * open operation and do not race to open the database twice.
     * @private
     * @type {Promise<TemporaryDatabase> | null}
     */
    _databasePromise;

    /**
     * @param {() => DatabaseCapabilities} getCapabilities
     */
    constructor(getCapabilities) {
        this._getCapabilities = getCapabilities;
        this._databasePromise = null;
    }

    /**
     * Return (and lazily open) the underlying LevelDB instance.
     * Concurrent callers share a single initialization promise so the database
     * is never opened more than once.
     * @returns {Promise<TemporaryDatabase>}
     */
    async _getDatabase() {
        if (this._databasePromise === null) {
            const capabilities = this._getCapabilities();
            this._databasePromise = getTemporaryDatabase(capabilities);
        }
        return this._databasePromise;
    }

    /**
     * Store a binary blob.
     * @param {RequestIdentifier} reqId
     * @param {string} filename
     * @param {Buffer} data
     * @returns {Promise<void>}
     */
    async storeBlob(reqId, filename, data) {
        const db = await this._getDatabase();
        await storeBlob(db, reqId, filename, data);
    }

    /**
     * Atomically store multiple blobs and mark the request as done in a
     * single LevelDB batch write.
     * @param {RequestIdentifier} reqId
     * @param {Array<{filename: string, data: Buffer}>} blobs
     * @returns {Promise<void>}
     */
    async storeBlobsAndMarkDone(reqId, blobs) {
        const db = await this._getDatabase();
        await storeBlobsAndMarkDone(db, reqId, blobs);
    }

    /**
     * Retrieve a stored binary blob.  Returns `null` if not found.
     * @param {RequestIdentifier} reqId
     * @param {string} filename
     * @returns {Promise<Buffer | null>}
     */
    async getBlob(reqId, filename) {
        const db = await this._getDatabase();
        return getBlob(db, reqId, filename);
    }

    /**
     * Delete a stored blob.
     * @param {RequestIdentifier} reqId
     * @param {string} filename
     * @returns {Promise<void>}
     */
    async deleteBlob(reqId, filename) {
        const db = await this._getDatabase();
        await deleteBlob(db, reqId, filename);
    }

    /**
     * Atomically mark a request as done.
     * @param {RequestIdentifier} reqId
     * @returns {Promise<void>}
     */
    async markDone(reqId) {
        const db = await this._getDatabase();
        await markDone(db, reqId);
    }

    /**
     * Check whether a request has been marked done.
     * @param {RequestIdentifier} reqId
     * @returns {Promise<boolean>}
     */
    async isDone(reqId) {
        const db = await this._getDatabase();
        return isDone(db, reqId);
    }
}

/** @typedef {TemporaryClass} Temporary */

/**
 * Type guard for Temporary.
 * @param {unknown} object
 * @returns {object is TemporaryClass}
 */
function isTemporary(object) {
    return object instanceof TemporaryClass;
}

/**
 * Create the Temporary capability that will be stored in root capabilities.
 * The database is opened lazily on first use.
 *
 * @param {() => DatabaseCapabilities} getCapabilities
 * @returns {Temporary}
 */
function makeTemporary(getCapabilities) {
    return new TemporaryClass(getCapabilities);
}

module.exports = {
    makeTemporary,
    isTemporary,
    storeBlob,
    getBlob,
    deleteBlob,
    markDone,
    isDone,
    storeBlobsAndMarkDone,
    sanitizeFilename,
};
