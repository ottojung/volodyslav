/**
 * RootDatabase module.
 * Provides slot-based (x/y) storage using LevelDB sublevels.
 *
 * The database maintains two fixed storage slots ("x" and "y").
 * One slot is "active" (live data) and the other is "inactive" (staging during migration).
 * A top-level meta sublevel records which slot is currently active.
 * Each slot has its own meta sublevel that stores the stored app version for that slot.
 */

const { getVersion } = require('../../../version');
const { makeTypedDatabase } = require('./typed_database');
const { stringToVersion, versionToString } = require('./types');

/** @typedef {import('./types').RootLevelType} RootLevelType */
/** @typedef {import('./types').SchemaSublevelType} SchemaSublevelType */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').Counter} Counter */
/** @typedef {import('./types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').Version} Version */

/**
 * @template T
 * @typedef {import('./typed_database').GenericDatabase<T>} GenericDatabase
 */

/**
 * Database for storing node output values.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: the computed value (object with type field)
 * @typedef {GenericDatabase<ComputedValue>} ValuesDatabase
 */

/**
 * Database for storing node freshness state.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: freshness state ('up-to-date' | 'potentially-outdated')
 * @typedef {GenericDatabase<Freshness>} FreshnessDatabase
 */

/**
 * A record storing the input dependencies of a node and their counters.
 * @typedef {object} InputsRecord
 * @property {string[]} inputs - Array of canonical input node names
 * @property {number[]} inputCounters - Array of counter values for each input (required when inputs.length > 0)
 */

/**
 * Database for storing node input dependencies.
 * Key: canonical node name
 * Value: inputs record with array of dependency names
 * @typedef {GenericDatabase<InputsRecord>} InputsDatabase
 */

/**
 * Database for reverse dependency index.
 * Key: canonical input node name
 * Value: array of canonical dependent node names
 * @typedef {GenericDatabase<NodeKeyString[]>} RevdepsDatabase
 */

/**
 * Database for storing node counters.
 * Key: canonical node name
 * Value: counter (monotonic integer tracking value changes)
 * @typedef {GenericDatabase<Counter>} CountersDatabase
 */

/**
 * Storage container for a single incremental graph slot.
 * @typedef {object} SchemaStorage
 * @property {ValuesDatabase} values - Node output values
 * @property {FreshnessDatabase} freshness - Node freshness state
 * @property {InputsDatabase} inputs - Node inputs index
 * @property {RevdepsDatabase} revdeps - Reverse dependencies (input node -> array of dependents)
 * @property {CountersDatabase} counters - Node counters (monotonic integers)
 * @property {(operations: DatabaseBatchOperation[]) => Promise<void>} batch - Batch operation interface for atomic writes
 */

/**
 * @template T
 * @typedef {import('./types').SimpleSublevel<T>} SimpleSublevel
 */

/**
 * The name of the key used to store the active slot in the top-level meta sublevel.
 */
const ACTIVE_SLOT_META_KEY = 'activeSlot';

/**
 * The name of the key used to store the version in each slot's meta sublevel.
 */
const SLOT_VERSION_KEY = 'version';

/**
 * The two fixed storage slots.
 */
const SLOT_X = 'x';
const SLOT_Y = 'y';

/**
 * The default active slot when no slot has been recorded yet.
 */
const ACTIVE_SLOT_DEFAULT = SLOT_X;

/**
 * The names of the data sublevels within each slot.
 */
const SLOT_DATA_SUBLEVELS = ['values', 'freshness', 'inputs', 'revdeps', 'counters', 'meta'];

/**
 * Root database class providing slot-based storage.
 */
class RootDatabaseClass {
    /**
     * The underlying Level database instance.
     * @private
     * @type {RootLevelType}
     */
    db;

    /**
     * The current app version.
     * @type {Version}
     */
    version;

    /**
     * The currently active slot name ("x" or "y").
     * @type {string}
     */
    activeSlot;

    /**
     * @constructor
     * @param {RootLevelType} db - The Level database instance
     * @param {Version} version - The current app version
     * @param {string} activeSlot - The active slot name ("x" or "y")
     */
    constructor(db, version, activeSlot) {
        this.db = db;
        this.version = version;
        this.activeSlot = activeSlot;
    }

    /**
     * Build slot storage for a given slot name.
     * @private
     * @param {string} slot - The slot name ("x" or "y")
     * @returns {SchemaStorage}
     */
    _makeSlotStorage(slot) {
        /** @type {SchemaSublevelType} */
        const slotSublevel = this.db.sublevel(slot, { valueEncoding: 'json' });

        /** @type {SimpleSublevel<ComputedValue>} */
        const valuesSublevel = slotSublevel.sublevel('values', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<Freshness>} */
        const freshnessSublevel = slotSublevel.sublevel('freshness', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<InputsRecord>} */
        const inputsSublevel = slotSublevel.sublevel('inputs', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<NodeKeyString[]>} */
        const revdepsSublevel = slotSublevel.sublevel('revdeps', { valueEncoding: 'json' });
        /** @type {SimpleSublevel<Counter>} */
        const countersSublevel = slotSublevel.sublevel('counters', { valueEncoding: 'json' });

        /** @type {(operations: DatabaseBatchOperation[]) => Promise<void>} */
        const batch = async (operations) => {
            if (operations.length === 0) {
                return;
            }
            await slotSublevel.batch(operations);
        };

        return {
            batch,
            values: makeTypedDatabase(valuesSublevel),
            freshness: makeTypedDatabase(freshnessSublevel),
            inputs: makeTypedDatabase(inputsSublevel),
            revdeps: makeTypedDatabase(revdepsSublevel),
            counters: makeTypedDatabase(countersSublevel),
        };
    }

    /**
     * Return the inactive slot name (opposite of the active slot).
     * @private
     * @returns {string}
     */
    _inactiveSlot() {
        return this.activeSlot === SLOT_X ? SLOT_Y : SLOT_X;
    }

    /**
     * Get the storage for the active slot.
     * @returns {SchemaStorage}
     */
    getActiveSlotStorage() {
        return this._makeSlotStorage(this.activeSlot);
    }

    /**
     * Get the storage for the inactive slot (used as migration destination).
     * @returns {SchemaStorage}
     */
    getInactiveSlotStorage() {
        return this._makeSlotStorage(this._inactiveSlot());
    }

    /**
     * Get schema-specific storage for the current version (alias for getActiveSlotStorage).
     * @returns {SchemaStorage}
     */
    getSchemaStorage() {
        return this.getActiveSlotStorage();
    }

    /**
     * Read the stored app version from the active slot's meta sublevel.
     * Returns undefined if no version has been stored yet.
     * @returns {Promise<Version|undefined>}
     */
    async getStoredVersion() {
        const slotSublevel = this.db.sublevel(this.activeSlot, { valueEncoding: 'json' });
        const slotMeta = slotSublevel.sublevel('meta', { valueEncoding: 'json' });
        const versionStr = await slotMeta.get(SLOT_VERSION_KEY);
        if (versionStr === undefined) {
            return undefined;
        }
        return stringToVersion(versionStr);
    }

    /**
     * Swap the active slot and write the current version to the new active slot's meta.
     * After this call, `this.activeSlot` is updated in memory to the new active slot.
     *
     * Write order for crash safety:
     *   1. Write version to new slot's meta first.
     *   2. Then flip the active slot marker.
     * If we crash between 1 and 2, the next migration run will clear the new slot
     * (removing the partial version write) and retry — the old active slot is unchanged.
     * @returns {Promise<void>}
     */
    async swapSlots() {
        const newActiveSlot = this._inactiveSlot();
        const versionStr = versionToString(this.version);

        // Step 1: record the current version in the new (soon-to-be-active) slot's meta.
        const newSlotSublevel = this.db.sublevel(newActiveSlot, { valueEncoding: 'json' });
        const newSlotMeta = newSlotSublevel.sublevel('meta', { valueEncoding: 'json' });
        await newSlotMeta.put(SLOT_VERSION_KEY, versionStr);

        // Step 2: flip the active slot marker.
        const topMeta = this.db.sublevel('meta', { valueEncoding: 'json' });
        await topMeta.put(ACTIVE_SLOT_META_KEY, newActiveSlot);

        this.activeSlot = newActiveSlot;
    }

    /**
     * Clear all sublevels of a given slot.
     * @private
     * @param {string} slot - The slot name to clear
     * @returns {Promise<void>}
     */
    async _clearSlot(slot) {
        const slotSublevel = this.db.sublevel(slot, { valueEncoding: 'json' });
        for (const subname of SLOT_DATA_SUBLEVELS) {
            await slotSublevel.sublevel(subname, { valueEncoding: 'json' }).clear();
        }
    }

    /**
     * Clear all sublevels of the inactive slot.
     * Used before migration to ensure a clean destination and to reclaim space after swap.
     * @returns {Promise<void>}
     */
    async clearInactiveSlot() {
        await this._clearSlot(this._inactiveSlot());
    }

    /**
     * Close the database connection.
     * @returns {Promise<void>}
     */
    async close() {
        await this.db.close();
    }
}


/**
 * @typedef {import('../../../level_database').LevelDatabase} LevelDatabase
 */

/**
 * @typedef {import('../../../subprocess/command').Command} Command
 */

/**
 * @typedef {import('../../../logger').Logger} Logger
 */

/**
 * @typedef {import('../../../filesystem/reader').FileReader} FileReader
 */

/**
 * @typedef {import('../../../filesystem/checker').FileChecker} FileChecker
 */

/**
 * @typedef {object} RootDatabaseCapabilities
 * @property {LevelDatabase} levelDatabase - The Level database capability
 * @property {Command} git - A command instance for Git operations.
 * @property {Logger} logger - A logger instance.
 * @property {FileReader} reader - A file reader instance.
 * @property {FileChecker} checker - A file checker instance.
 */

/**
 * Read the last (highest-index) schema version from the legacy "schemas" sublevel.
 * Returns undefined if no legacy schemas exist.
 * @param {import('./types').ListOfSchemasType} legacySchemasLevel
 * @returns {Promise<Version|undefined>}
 */
async function readLastLegacySchema(legacySchemasLevel) {
    let lastVersion = undefined;
    let lastIndex = -1;
    for await (const [key, value] of legacySchemasLevel.iterator()) {
        if (value > lastIndex) {
            lastVersion = key;
            lastIndex = value;
        }
    }
    return lastVersion;
}

/**
 * Import data from a legacy version-keyed namespace into slot "x".
 * Writes x/meta/version = legacyVersion so subsequent startup can detect the schema
 * and run migration if needed.
 * @param {RootLevelType} db
 * @param {Version} legacyVersion
 * @returns {Promise<void>}
 */
async function importLegacyToSlot(db, legacyVersion) {
    const legacyVersionStr = versionToString(legacyVersion);
    /** @type {SchemaSublevelType} */
    const srcSublevel = db.sublevel(legacyVersionStr, { valueEncoding: 'json' });
    /** @type {SchemaSublevelType} */
    const dstSublevel = db.sublevel(SLOT_X, { valueEncoding: 'json' });

    for (const subname of ['values', 'freshness', 'inputs', 'revdeps', 'counters']) {
        const src = srcSublevel.sublevel(subname, { valueEncoding: 'json' });
        const dst = dstSublevel.sublevel(subname, { valueEncoding: 'json' });
        /** @type {Array<{type: 'put', key: string, value: string}>} */
        const ops = [];
        for await (const [key, value] of src.iterator()) {
            ops.push({ type: 'put', key, value });
        }
        if (ops.length > 0) {
            await dst.batch(ops);
        }
    }

    // Write the legacy version to x/meta so the migration runner can detect a version mismatch.
    const xMeta = dstSublevel.sublevel('meta', { valueEncoding: 'json' });
    await xMeta.put(SLOT_VERSION_KEY, legacyVersionStr);

    // Record the active slot in the top-level meta.
    const topMeta = db.sublevel('meta', { valueEncoding: 'json' });
    await topMeta.put(ACTIVE_SLOT_META_KEY, SLOT_X);
}

/**
 * Factory function to create a RootDatabase instance.
 * On first call against a legacy database (one using the old per-version namespace layout),
 * performs a one-time import of the last legacy schema into slot "x".
 * @param {RootDatabaseCapabilities} capabilities - The capabilities required to create the database
 * @param {string} databasePath - Path to the database directory
 * @returns {Promise<RootDatabaseClass>}
 */
async function makeRootDatabase(capabilities, databasePath) {
    const version = stringToVersion(await getVersion(capabilities));
    /** @type {RootLevelType} */
    const db = capabilities.levelDatabase.initialize(databasePath);
    await db.open();

    // Read the active slot from the top-level meta sublevel.
    const topMeta = db.sublevel('meta', { valueEncoding: 'json' });
    const storedActiveSlot = await topMeta.get(ACTIVE_SLOT_META_KEY);

    let activeSlot;
    if (storedActiveSlot !== undefined) {
        // New-format database: use the stored active slot.
        activeSlot = storedActiveSlot;
    } else {
        // Either a brand-new database or a legacy database using per-version namespaces.
        // Check for the legacy "schemas" sublevel.
        /** @type {import('./types').ListOfSchemasType} */
        const legacySchemasLevel = db.sublevel('schemas', { valueEncoding: 'json' });
        const legacyLastVersion = await readLastLegacySchema(legacySchemasLevel);

        if (legacyLastVersion !== undefined) {
            // Legacy database detected: import the last schema into slot "x".
            await importLegacyToSlot(db, legacyLastVersion);
        }

        // Default to slot "x" (either new DB or legacy import just completed).
        activeSlot = ACTIVE_SLOT_DEFAULT;
    }

    return new RootDatabaseClass(db, version, activeSlot);
}

/**
 * Type guard for RootDatabase.
 * @param {unknown} object
 * @returns {object is RootDatabaseClass}
 */
function isRootDatabase(object) {
    return object instanceof RootDatabaseClass;
}

/** @typedef {RootDatabaseClass} RootDatabase */

module.exports = {
    makeRootDatabase,
    isRootDatabase,
};
