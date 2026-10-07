/**
 * The durable staging surface one Journal 3 synchronization builds into before
 * cutover.
 *
 * `$id-4373538486707762` requires that implementation-owned persistent
 * IncrementalGraph state carry no hostname, Git branch, repository identity or
 * other transport locator, and `incremental-graph-journal-testing.md`
 * §Synchronization staging contains no transport locator requires the regression
 * which enumerates every persisted sublevel name and key staging uses and rejects
 * one containing a hostname string or the `_h_` prefix. A sublevel name is the
 * only part of the persisted surface an implementation chooses freely, so the
 * name and every key this module writes are fixed here rather than derived from
 * deployment configuration.
 *
 * The name is a constant, and the keys are the Journal sublevel's own key
 * families (`state`, `record|<author>|<padded coordinate>`,
 * `occurrence|<canonical node key>`) plus the graph sublevel names, so a staged
 * target is byte-compatible with the replica it will become. Staging therefore
 * needs no separate key vocabulary, and there is no key under which a transport
 * locator could be stored.
 */

/** @typedef {import('./types').RootLevelType} RootLevelType */
/** @typedef {import('./types').SchemaSublevelType} SchemaSublevelType */
/** @typedef {import('./types').GlobalSublevelType} GlobalSublevelType */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */

/**
 * @template T
 * @template [K=import('./types').DatabaseKey]
 * @typedef {import('./types').SimpleSublevel<T, K>} SimpleSublevel
 */

/**
 * @template T
 * @template K
 * @typedef {import('./typed_database').GenericDatabase<T, K>} GenericDatabase
 */

/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').TimestampRecord} TimestampRecord */
/** @typedef {import('./types').JournalText} JournalText */
/** @typedef {import('./types').JournalKey} JournalKey */

const { declaredValueEncodingForSublevelName } = require('./sublevel_encoding');
const { makeTypedDatabase } = require('./typed_database');

/**
 * The name of the single sublevel synchronization stages into.
 *
 * It names a role, not a peer: `sync_staging` is the same name for every
 * receiver, at every host, in every deployment. There is no second staging
 * sublevel per concurrent peer, because a receiver holds exclusive maintenance
 * ownership for the duration of one synchronization and publishes at most one
 * staging target per operation.
 *
 * @type {'sync_staging'}
 */
const SYNC_STAGING_SUBLEVEL_NAME = 'sync_staging';

/**
 * Every persisted sublevel name this implementation owns which synchronization
 * staging may write under, in the order a test should enumerate them.
 *
 * The list is exported rather than recomputed by a test so that the regression
 * which rejects a transport locator covers the whole surface this tree
 * implements: adding a staging sublevel without adding it here would leave the
 * regression blind to the new name.
 *
 * @type {ReadonlyArray<string>}
 */
const SYNC_STAGING_PERSISTED_NAMES = Object.freeze([
    SYNC_STAGING_SUBLEVEL_NAME,
]);

/**
 * The top-level sublevel synchronization stages into.
 *
 * @param {RootLevelType} db
 * @returns {SchemaSublevelType}
 */
function syncStagingSublevel(db) {
    /** @type {SchemaSublevelType} */
    const staging = db.sublevel(SYNC_STAGING_SUBLEVEL_NAME, {
        valueEncoding: declaredValueEncodingForSublevelName(SYNC_STAGING_SUBLEVEL_NAME),
    });
    return staging;
}

/**
 * Build the staging storage over one top-level sublevel.
 *
 * The staged target mirrors a replica's own sublevel names, so the same
 * lowering writes both the active replica and the staged one, and the staged
 * target is a byte-compatible replica rather than a second vocabulary.
 *
 * @param {RootLevelType} db
 * @param {string} namespaceName - The top-level sublevel name to stage into.
 * @returns {SchemaStorage}
 */
function buildSyncStagingStorage(db, namespaceName) {
    /** @type {SchemaSublevelType} */
    const namespace = db.sublevel(namespaceName, {
        valueEncoding: declaredValueEncodingForSublevelName(namespaceName),
    });
    /** @type {SimpleSublevel<ComputedValue, NodeIdentifier>} */
    const valuesSublevel = namespace.sublevel('values', {
        valueEncoding: declaredValueEncodingForSublevelName('values'),
    });
    /** @type {SimpleSublevel<Freshness, NodeIdentifier>} */
    const freshnessSublevel = namespace.sublevel('freshness', {
        valueEncoding: declaredValueEncodingForSublevelName('freshness'),
    });
    /** @type {SimpleSublevel<NodeIdentifier[], NodeIdentifier>} */
    const validSublevel = namespace.sublevel('valid', {
        valueEncoding: declaredValueEncodingForSublevelName('valid'),
    });
    /** @type {SimpleSublevel<TimestampRecord, NodeIdentifier>} */
    const timestampsSublevel = namespace.sublevel('timestamps', {
        valueEncoding: declaredValueEncodingForSublevelName('timestamps'),
    });
    /** @type {GlobalSublevelType} */
    const globalSublevel = namespace.sublevel('global', {
        valueEncoding: declaredValueEncodingForSublevelName('global'),
    });
    /** @type {SimpleSublevel<JournalText, JournalKey>} */
    const journalSublevel = namespace.sublevel('journal', {
        valueEncoding: declaredValueEncodingForSublevelName('journal'),
    });
    return {
        // Staging deliberately declares no version guard. A staged target is not
        // an active replica, and `assertCompatibleIdentity` has already decided
        // compatibility from the held snapshot before anything is staged, so a
        // version check here would re-derive a decision the operation made once.
        batch: async (operations) => {
            if (operations.length > 0) {
                await namespace.batch(operations);
            }
        },
        values: makeTypedDatabase(valuesSublevel),
        freshness: makeTypedDatabase(freshnessSublevel),
        valid: makeTypedDatabase(validSublevel),
        timestamps: makeTypedDatabase(timestampsSublevel),
        global: makeTypedDatabase(globalSublevel),
        journal: makeTypedDatabase(journalSublevel),
    };
}

/**
 * The staging storage of the receiver.
 *
 * @param {RootLevelType} db
 * @returns {SchemaStorage}
 */
function syncStagingStorage(db) {
    return buildSyncStagingStorage(db, SYNC_STAGING_SUBLEVEL_NAME);
}

/**
 * Discard a staged target.
 *
 * A staging sublevel holds only inactive state, so clearing it is a supported
 * way to abandon a staging attempt: it cannot remove a committed record or a
 * selected occurrence, because those live in a replica namespace.
 *
 * @param {RootLevelType} db
 * @returns {Promise<void>}
 */
async function clearSyncStaging(db) {
    await syncStagingSublevel(db).clear();
}

module.exports = {
    SYNC_STAGING_PERSISTED_NAMES,
    SYNC_STAGING_SUBLEVEL_NAME,
    buildSyncStagingStorage,
    clearSyncStaging,
    syncStagingStorage,
    syncStagingSublevel,
};
