/**
 * Hostname staging storage helpers for sync merge.
 *
 * Remote host snapshots are imported into flat `_h_<hostname>` top-level
 * sublevels before graph merge.  Each sublevel mirrors the schema of a replica
 * (values, freshness, inputs, revdeps, counters, timestamps) but uses bare
 * (unchecked) storage so that the foreign schema version is not enforced.
 *
 * These functions operate directly on the root LevelDB instance so they can
 * read/write hostname sublevels without going through the typed replica layer.
 */

const { makeTypedDatabase } = require('./typed_database');
const { stringToNodeKeyString, stringToVersion } = require('./types');
const { RAW_BATCH_CHUNK_SIZE } = require('./constants');

/**
 * Thrown when a hostname string is invalid for use as a staging namespace key.
 * The hostname is embedded into LevelDB sublevel names and raw key prefixes, so
 * characters that act as delimiters (e.g. `!`) or path separators (`/`, `\`)
 * must be rejected to prevent namespace collisions or key corruption.
 */
class InvalidHostnameError extends Error {
    /**
     * @param {string} hostname
     * @param {string} reason
     */
    constructor(hostname, reason) {
        super(`Invalid hostname '${hostname}': ${reason}`);
        this.name = 'InvalidHostnameError';
        this.hostname = hostname;
    }
}

/**
 * @param {unknown} object
 * @returns {object is InvalidHostnameError}
 */
function isInvalidHostnameError(object) {
    return object instanceof InvalidHostnameError;
}

/**
 * Validate a hostname string for use as a staging namespace key.
 * Must be non-empty and must not contain `/`, `\`, or `!`.
 *
 * @param {string} hostname
 * @returns {string} The validated hostname (same value, for chaining).
 * @throws {InvalidHostnameError} If the hostname is invalid.
 */
function validateHostname(hostname) {
    if (typeof hostname !== 'string' || hostname.length === 0) {
        throw new InvalidHostnameError(hostname, 'must be a non-empty string');
    }
    if (hostname.includes('/') || hostname.includes('\\') || hostname.includes('!')) {
        throw new InvalidHostnameError(hostname, "must not contain '/', '\\\\', or '!'");
    }
    return hostname;
}

/** @typedef {import('./types').RootLevelType} RootLevelType */
/** @typedef {import('./types').SchemaSublevelType} SchemaSublevelType */
/** @typedef {import('./types').Version} Version */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').InputsRecord} InputsRecord */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').Counter} Counter */
/** @typedef {import('./types').TimestampRecord} TimestampRecord */

/**
 * @template T
 * @typedef {import('./types').SimpleSublevel<T>} SimpleSublevel
 */

/**
 * Build a bare SchemaStorage without any version-check enforcement.
 * Used for hostname staging namespaces where the data originates from a remote
 * replica and should not be constrained by the local application version.
 *
 * The returned storage's `batch` function simply writes operations without any
 * global/version check.  Individual sub-database `put`/`del` calls are also
 * unconstrained.
 *
 * @param {SchemaSublevelType} namespaceSublevel - The namespace's top-level sublevel.
 * @returns {SchemaStorage}
 */
function buildBareSchemaStorage(namespaceSublevel) {
    /** @type {SimpleSublevel<ComputedValue>} */
    const valuesSublevel = namespaceSublevel.sublevel('values', { valueEncoding: 'json' });
    /** @type {SimpleSublevel<Freshness>} */
    const freshnessSublevel = namespaceSublevel.sublevel('freshness', { valueEncoding: 'json' });
    /** @type {SimpleSublevel<InputsRecord>} */
    const inputsSublevel = namespaceSublevel.sublevel('inputs', { valueEncoding: 'json' });
    /** @type {SimpleSublevel<NodeKeyString[]>} */
    const revdepsSublevel = namespaceSublevel.sublevel('revdeps', { valueEncoding: 'json' });
    /** @type {SimpleSublevel<Counter>} */
    const countersSublevel = namespaceSublevel.sublevel('counters', { valueEncoding: 'json' });
    /** @type {SimpleSublevel<TimestampRecord>} */
    const timestampsSublevel = namespaceSublevel.sublevel('timestamps', { valueEncoding: 'json' });
    /** @type {import('abstract-level').AbstractSublevel<SchemaSublevelType, import('./types').SublevelFormat, string, Version>} */
    const globalSublevel = namespaceSublevel.sublevel('global', { valueEncoding: 'json' });

    /** @type {(operations: DatabaseBatchOperation[]) => Promise<void>} */
    const batch = async (operations) => {
        if (operations.length > 0) {
            await namespaceSublevel.batch(operations);
        }
    };

    return {
        batch,
        values: makeTypedDatabase(valuesSublevel),
        freshness: makeTypedDatabase(freshnessSublevel),
        inputs: makeTypedDatabase(inputsSublevel),
        revdeps: makeTypedDatabase(revdepsSublevel),
        counters: makeTypedDatabase(countersSublevel),
        timestamps: makeTypedDatabase(timestampsSublevel),
        global: makeTypedDatabase(globalSublevel),
    };
}

/**
 * Returns a bare SchemaStorage for a hostname staging namespace.
 * The storage reads/writes under `_h_<hostname>` and does NOT enforce any
 * local version check.
 *
 * @param {RootLevelType} db - The root LevelDB instance.
 * @param {string} hostname - The hostname key (must be non-empty, no `/`, `\`, or `!`).
 * @returns {SchemaStorage}
 * @throws {InvalidHostnameError} If the hostname is invalid.
 */
function hostnameSchemaStorage(db, hostname) {
    validateHostname(hostname);
    /** @type {SchemaSublevelType} */
    const hostnameSub = db.sublevel(`_h_${hostname}`, { valueEncoding: 'json' });
    return buildBareSchemaStorage(hostnameSub);
}

/**
 * Clear all data stored under the `_h_<hostname>` staging namespace.
 *
 * @param {RootLevelType} db - The root LevelDB instance.
 * @param {string} hostname - The hostname key (must be non-empty, no `/`, `\`, or `!`).
 * @returns {Promise<void>}
 * @throws {InvalidHostnameError} If the hostname is invalid.
 */
async function clearHostnameStorage(db, hostname) {
    validateHostname(hostname);
    /** @type {SchemaSublevelType} */
    const hostnameSub = db.sublevel(`_h_${hostname}`, { valueEncoding: 'json' });
    await hostnameSub.clear();
}

/**
 * Build the raw LevelDB key for a hostname staging entry.
 * Format: `!_h_<hostname>!!<sublevelName>!<subkey>`
 *
 * @param {string} hostname
 * @param {string} sublevelName - e.g. 'meta', 'values', 'freshness', etc.
 * @param {string} subkey
 * @returns {NodeKeyString}
 */
function hostnameRawKey(hostname, sublevelName, subkey) {
    return stringToNodeKeyString(`!_h_${hostname}!!${sublevelName}!${subkey}`);
}

/**
 * Reads the app version stored in a hostname's staging global sublevel.
 * Returns `undefined` when the hostname storage contains no version entry.
 *
 * @param {RootLevelType} db - The root LevelDB instance.
 * @param {string} hostname
 * @returns {Promise<Version | undefined>}
 * @throws {InvalidHostnameError} If the hostname is invalid.
 */
async function getHostnameGlobalVersion(db, hostname) {
    validateHostname(hostname);
    const rawKey = hostnameRawKey(hostname, 'global', 'version');
    const raw = await db.get(rawKey);
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw === 'string') {
        return stringToVersion(raw);
    }
    return undefined;
}

/**
 * Write a key/value pair into a hostname's staging global sublevel.
 *
 * @param {RootLevelType} db - The root LevelDB instance.
 * @param {string} hostname
 * @param {string} key - The key to write (e.g. 'version').
 * @param {*} value - The value to store.
 * @returns {Promise<void>}
 * @throws {InvalidHostnameError} If the hostname is invalid.
 */
async function setHostnameGlobal(db, hostname, key, value) {
    validateHostname(hostname);
    const rawKey = hostnameRawKey(hostname, 'global', key);
    await db.put(rawKey, value);
}

/**
 * Write raw `{ sublevelName, subkey, value }` entries into a hostname's
 * staging namespace without going through the typed schema layer.
 *
 * @param {RootLevelType} db - The root LevelDB instance.
 * @param {string} hostname
 * @param {Array<{ sublevelName: string, subkey: string, value: * }>} entries
 * @returns {Promise<void>}
 * @throws {InvalidHostnameError} If the hostname is invalid.
 */
async function rawPutAllToHostname(db, hostname, entries) {
    validateHostname(hostname);
    /**
     * @param {{ sublevelName: string, subkey: string, value: * }} entry
     * @returns {{ type: 'put', key: NodeKeyString, value: * }}
     */
    function makePutOp(entry) {
        return {
            type: 'put',
            key: hostnameRawKey(hostname, entry.sublevelName, entry.subkey),
            value: entry.value,
        };
    }

    for (let i = 0; i < entries.length; i += RAW_BATCH_CHUNK_SIZE) {
        const chunk = entries.slice(i, i + RAW_BATCH_CHUNK_SIZE);
        const ops = chunk.map(makePutOp);
        await db.batch(ops);
    }
}

module.exports = {
    buildBareSchemaStorage,
    hostnameSchemaStorage,
    clearHostnameStorage,
    getHostnameGlobalVersion,
    setHostnameGlobal,
    rawPutAllToHostname,
    InvalidHostnameError,
    isInvalidHostnameError,
    validateHostname,
};
