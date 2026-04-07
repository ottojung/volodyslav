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
 * meta/version check.  Individual sub-database `put`/`del` calls are also
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
    };
}

/**
 * Returns a bare SchemaStorage for a hostname staging namespace.
 * The storage reads/writes under `_h_<hostname>` and does NOT enforce any
 * local version check.
 *
 * @param {RootLevelType} db - The root LevelDB instance.
 * @param {string} hostname - The hostname key (must be non-empty, no `/`).
 * @returns {SchemaStorage}
 */
function hostnameSchemaStorage(db, hostname) {
    /** @type {SchemaSublevelType} */
    const hostnameSub = db.sublevel(`_h_${hostname}`, { valueEncoding: 'json' });
    return buildBareSchemaStorage(hostnameSub);
}

/**
 * Clear all data stored under the `_h_<hostname>` staging namespace.
 *
 * @param {RootLevelType} db - The root LevelDB instance.
 * @param {string} hostname - The hostname key (must be non-empty, no `/`).
 * @returns {Promise<void>}
 */
async function clearHostnameStorage(db, hostname) {
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
 * Reads the app version stored in a hostname's staging meta sublevel.
 * Returns `undefined` when the hostname storage contains no version entry.
 *
 * @param {RootLevelType} db - The root LevelDB instance.
 * @param {string} hostname
 * @returns {Promise<Version | undefined>}
 */
async function getHostnameMetaVersion(db, hostname) {
    const rawKey = hostnameRawKey(hostname, 'meta', 'version');
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
 * Write a meta key/value pair into a hostname's staging meta sublevel.
 *
 * @param {RootLevelType} db - The root LevelDB instance.
 * @param {string} hostname
 * @param {string} key - The meta key to write (e.g. 'version').
 * @param {*} value - The value to store.
 * @returns {Promise<void>}
 */
async function setHostnameMeta(db, hostname, key, value) {
    const rawKey = hostnameRawKey(hostname, 'meta', key);
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
 */
async function rawPutAllToHostname(db, hostname, entries) {
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
    const ops = entries.map(makePutOp);
    if (ops.length > 0) {
        await db.batch(ops);
    }
}

module.exports = {
    buildBareSchemaStorage,
    hostnameSchemaStorage,
    clearHostnameStorage,
    getHostnameMetaVersion,
    setHostnameMeta,
    rawPutAllToHostname,
};
