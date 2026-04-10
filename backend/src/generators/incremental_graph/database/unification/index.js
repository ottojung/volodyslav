/**
 * Public exports for the gentle-unification subsystem.
 *
 * The unification subsystem provides a domain-agnostic algorithm for
 * reconciling one store into another with minimal writes.  Each adapter
 * implements the UnificationAdapter interface; the core unifyStores function
 * drives the common algorithm.
 *
 * Available adapters:
 *   makeDbToDbAdapter    — one SchemaStorage (or InMemorySchemaStorage) → another
 *   makeInMemorySchemaStorage — temporary in-memory capture store
 *   makeFsToDbAdapter    — snapshot directory → database sublevel
 *   makeDbToFsAdapter    — database sublevel → snapshot directory
 */

/** @typedef {import('./db_to_db').ReadableSchemaStorage} ReadableSchemaStorage */

const {
    unifyStores,
    UnificationListError,
    isUnificationListError,
    UnificationReadError,
    isUnificationReadError,
    UnificationWriteError,
    isUnificationWriteError,
    UnificationDeleteError,
    isUnificationDeleteError,
    UnificationCommitError,
    isUnificationCommitError,
} = require('./core');

const {
    makeDbToDbAdapter,
    makeInMemorySchemaStorage,
    stableStringify,
} = require('./db_to_db');

const { makeFsToDbAdapter } = require('./fs_to_db');
const { makeDbToFsAdapter } = require('./db_to_fs');

module.exports = {
    unifyStores,
    UnificationListError,
    isUnificationListError,
    UnificationReadError,
    isUnificationReadError,
    UnificationWriteError,
    isUnificationWriteError,
    UnificationDeleteError,
    isUnificationDeleteError,
    UnificationCommitError,
    isUnificationCommitError,
    makeDbToDbAdapter,
    makeInMemorySchemaStorage,
    stableStringify,
    makeFsToDbAdapter,
    makeDbToFsAdapter,
};
